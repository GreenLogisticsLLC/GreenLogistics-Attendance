import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const tempDir = mkdtempSync(path.join(tmpdir(), "greenos-paypal-invoicing-"));
const dbPath = path.join(tempDir, "test.db");
const originalFetch = globalThis.fetch;

let prisma: typeof import("../../../config/database.js").prisma;
let config: typeof import("../../../config/env.js").config;
let payPalInvoicingService: typeof import("./paypal-invoicing.service.js").payPalInvoicingService;
let payPalCheckoutService: typeof import("./paypal-checkout.service.js").payPalCheckoutService;
let clearPayPalTokenCache: typeof import("./paypal-client.js").clearPayPalTokenCache;
let envMod: typeof import("./paypal-env.js");
let safety: typeof import("./paypal-invoicing-safety.js");
let pricing: typeof import("../invoice-pricing.js");

const actor = { userId: "test-owner", role: "Owner", accountingSubRole: null };

const ENV_KEYS = [
    "PAYPAL_MODE",
    "PAYPAL_INVOICING_MODE",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_WEBHOOK_ID",
    "PAYPAL_SANDBOX_CLIENT_ID",
    "PAYPAL_SANDBOX_CLIENT_SECRET",
    "PAYPAL_SANDBOX_WEBHOOK_ID",
    "PAYPAL_SANDBOX_INVOICING_WEBHOOK_ID",
    "PAYPAL_LIVE_CLIENT_ID",
    "PAYPAL_LIVE_CLIENT_SECRET",
    "PAYPAL_LIVE_WEBHOOK_ID",
    "PAYPAL_LIVE_INVOICING_WEBHOOK_ID",
] as const;

function resetEnv() {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.PAYPAL_SANDBOX_CLIENT_ID = "sb-test-client";
    process.env.PAYPAL_SANDBOX_CLIENT_SECRET = "sb-test-secret";
    process.env.PAYPAL_SANDBOX_WEBHOOK_ID = "WH-SB-CHECKOUT";
    process.env.PAYPAL_SANDBOX_INVOICING_WEBHOOK_ID = "WH-SB-INVOICING";
}

function enableLiveCredentials() {
    process.env.PAYPAL_LIVE_CLIENT_ID = "live-test-client";
    process.env.PAYPAL_LIVE_CLIENT_SECRET = "live-test-secret";
    process.env.PAYPAL_LIVE_INVOICING_WEBHOOK_ID = "WH-LIVE-INVOICING";
}

function response(json: unknown, status = 200): Response {
    const text = json == null ? "" : JSON.stringify(json);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status >= 200 && status < 300 ? "OK" : "ERROR",
        json: async () => json,
        text: async () => text,
    } as Response;
}

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

type MockInvoice = {
    id: string;
    status: string;
    requestId: string;
    body: Record<string, any>;
    environment: "sandbox" | "live";
    paidValue?: string;
    transactionId?: string;
    totalOverride?: string;
};

function installInvoicingMock() {
    const calls: Call[] = [];
    const invoices = new Map<string, MockInvoice>();
    const byRequestId = new Map<string, string>();
    const behavior = {
        /** "before" = request never reached PayPal; "after" = created remotely but response lost. */
        createFailure: null as null | "before" | "after",
        createFailureCount: 0,
    };
    let seq = 0;

    const totalOf = (inv: MockInvoice) => {
        if (inv.totalOverride) return inv.totalOverride;
        const items = (inv.body.items || []) as Array<{
            quantity: string;
            unit_amount: { value: string };
        }>;
        const cents = items.reduce(
            (sum, i) => sum + Math.round(Number(i.quantity) * Number(i.unit_amount.value) * 100),
            0
        );
        return (cents / 100).toFixed(2);
    };

    const render = (inv: MockInvoice) => {
        const base =
            inv.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
        const total = totalOf(inv);
        const paid = inv.status === "PAID";
        return {
            id: inv.id,
            status: inv.status,
            detail: {
                invoice_number: inv.body.detail.invoice_number,
                invoice_date: inv.body.detail.invoice_date,
                currency_code: "USD",
                payment_term: inv.body.detail.payment_term,
                metadata: {
                    recipient_view_url: `https://www.paypal.test/invoice/p/#${inv.id}`,
                },
            },
            amount: { currency_code: "USD", value: total },
            ...(paid
                ? {
                      payments: {
                          paid_amount: {
                              currency_code: "USD",
                              value: inv.paidValue || total,
                          },
                          transactions: [{ payment_id: inv.transactionId || "PAY-TX-1" }],
                      },
                  }
                : {}),
            links: [
                { rel: "self", href: `${base}/v2/invoicing/invoices/${inv.id}`, method: "GET" },
                ...(inv.status === "DRAFT"
                    ? []
                    : [{ rel: "payer-view", href: `https://www.paypal.test/invoice/p/#${inv.id}` }]),
            ],
        };
    };

    globalThis.fetch = (async (urlLike: RequestInfo | URL, init?: RequestInit) => {
        const url = String(urlLike);
        const method = String(init?.method || "GET").toUpperCase();
        const headers: Record<string, string> = {};
        new Headers(init?.headers || {}).forEach((v, k) => {
            headers[k.toLowerCase()] = v;
        });
        let body: any = null;
        try {
            body = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
            body = String(init?.body);
        }
        calls.push({ method, url, headers, body });
        const environment: "sandbox" | "live" = url.includes("sandbox") ? "sandbox" : "live";

        if (url.endsWith("/v1/oauth2/token")) {
            return response({ access_token: `${environment}-token`, expires_in: 3600 });
        }
        if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
            return response({ verification_status: "SUCCESS" });
        }
        if (url.endsWith("/v2/invoicing/invoices") && method === "POST") {
            const requestId = headers["paypal-request-id"];
            if (behavior.createFailure === "before" && behavior.createFailureCount > 0) {
                behavior.createFailureCount -= 1;
                throw new TypeError("fetch failed (simulated timeout before PayPal)");
            }
            let id = requestId ? byRequestId.get(requestId) : undefined;
            if (!id) {
                seq += 1;
                id = `INV2-TEST-${seq}`;
                invoices.set(id, {
                    id,
                    status: "DRAFT",
                    requestId: requestId || "",
                    body: body as Record<string, any>,
                    environment,
                });
                if (requestId) byRequestId.set(requestId, id);
            }
            if (behavior.createFailure === "after" && behavior.createFailureCount > 0) {
                behavior.createFailureCount -= 1;
                throw new TypeError("fetch failed (simulated timeout after PayPal created)");
            }
            const base =
                environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
            return response(
                { rel: "self", href: `${base}/v2/invoicing/invoices/${id}`, method: "GET" },
                201
            );
        }
        if (url.includes("/v2/invoicing/search-invoices") && method === "POST") {
            const wanted = body?.invoice_number;
            const items = [...invoices.values()]
                .filter((i) => i.environment === environment)
                .filter((i) => !wanted || i.body.detail.invoice_number === wanted)
                .map(render);
            return response({ total_items: items.length, items });
        }
        const invoiceMatch = /\/v2\/invoicing\/invoices\/([^/?]+)(\/[a-z]+)?/.exec(url);
        if (invoiceMatch) {
            const inv = invoices.get(decodeURIComponent(invoiceMatch[1]));
            const sub = invoiceMatch[2];
            if (!inv) return response({ message: "not found" }, 404);
            if (method === "GET" && !sub) return response(render(inv));
            if (method === "PUT" && !sub) {
                // Fully update draft/scheduled — used to pin invoice_date before send.
                inv.body = { ...(body as Record<string, any>) };
                if (inv.status === "SCHEDULED") inv.status = "DRAFT";
                return response(null, 200);
            }
            if (method === "DELETE") {
                invoices.delete(inv.id);
                return response(null, 204);
            }
            if (method === "POST" && sub === "/send") {
                const issue = String(inv.body?.detail?.invoice_date || "");
                const todayUtc = new Date().toISOString().slice(0, 10);
                // Mirror PayPal: future issue date → SCHEDULED (no email).
                if (issue && issue > todayUtc) {
                    inv.status = "SCHEDULED";
                    return response({
                        rel: "payer-view",
                        href: `https://www.paypal.test/invoice/p/#${inv.id}`,
                        method: "GET",
                    });
                }
                inv.status = "SENT";
                return response({
                    rel: "payer-view",
                    href: `https://www.paypal.test/invoice/p/#${inv.id}`,
                    method: "GET",
                });
            }
            if (method === "POST" && sub === "/cancel") {
                inv.status = "CANCELLED";
                return response(null, 204);
            }
            if (method === "POST" && sub === "/remind") return response(null, 204);
        }
        throw new Error(`Unexpected PayPal invoicing test URL: ${method} ${url}`);
    }) as typeof fetch;

    return {
        calls,
        invoices,
        behavior,
        setStatus(id: string, status: string, extra: Partial<MockInvoice> = {}) {
            const inv = invoices.get(id);
            assert.ok(inv, `mock invoice ${id} exists`);
            inv.status = status;
            Object.assign(inv, extra);
        },
        createCalls: () =>
            calls.filter((c) => c.method === "POST" && c.url.endsWith("/v2/invoicing/invoices")),
        render,
    };
}

async function createShipment(input: {
    customerRate?: number;
    paid?: boolean;
    email?: string | null;
} = {}) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `PayPal invoicing ${suffix}`,
            loadNumber: `GL${Math.floor(Math.random() * 90000) + 10000}`,
            customerName: "Invoice Customer LLC",
            customerEmail: input.email === undefined ? "ar@example.test" : input.email,
            customerRate: input.customerRate ?? 1000,
            accessorialCharges: 0,
            customerPaymentMethod: "ACH",
            accountingReadyForBilling: true,
            customerPaidAt: input.paid ? new Date() : null,
            paymentStatus: input.paid ? "CUSTOMER_PAID" : null,
        },
    });
}

async function setFee(
    feeType: "none" | "percentage" | "fixed",
    value = 0,
    label = "Handling fee"
) {
    const current = pricing.defaultInvoicePricingSettings();
    if (feeType === "none") {
        await pricing.saveInvoicePricingSettings({ ...current, version: 5 }, "test-owner");
        return;
    }
    const validated = pricing.validateInvoicePricingUpdate(
        { ...current, version: 5 },
        {
            enabled: true,
            feeType,
            percentageValue: feeType === "percentage" ? value : 0,
            fixedAmountUsd: feeType === "fixed" ? value : 0,
            lineItemLabel: label,
            acknowledgePolicy: true,
        },
        "test-owner"
    );
    assert.ok(validated.ok, "fee settings validate");
    await pricing.saveInvoicePricingSettings(validated.next, "test-owner");
}

const webhookHeaders = {
    "paypal-transmission-id": "tx-inv",
    "paypal-transmission-time": "2026-11-16T00:00:00Z",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "sig",
};

before(async () => {
    process.env.DATABASE_URL = `file:${dbPath}`;
    resetEnv();
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
        cwd: path.resolve("."),
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
        stdio: "ignore",
    });
    ({ prisma } = await import("../../../config/database.js"));
    ({ config } = await import("../../../config/env.js"));
    ({ payPalInvoicingService } = await import("./paypal-invoicing.service.js"));
    ({ payPalCheckoutService } = await import("./paypal-checkout.service.js"));
    ({ clearPayPalTokenCache } = await import("./paypal-client.js"));
    envMod = await import("./paypal-env.js");
    safety = await import("./paypal-invoicing-safety.js");
    pricing = await import("../invoice-pricing.js");
});

beforeEach(async () => {
    globalThis.fetch = originalFetch;
    resetEnv();
    clearPayPalTokenCache();
    await prisma.payPalInvoiceOperation.deleteMany();
    await prisma.payPalCustomerInvoice.deleteMany();
    await prisma.payPalWebhookEvent.deleteMany();
    await prisma.payPalCustomerOrder.deleteMany();
    await prisma.setting.deleteMany({ where: { category: pricing.INVOICE_PRICING_CATEGORY } });
    await prisma.shipmentLead.deleteMany({ where: { source: "TEST" } });
});

after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) delete process.env[key];
    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
});

test("invoicing mode defaults to sandbox and is independent of PAYPAL_MODE", () => {
    process.env.PAYPAL_MODE = "live";
    enableLiveCredentials();
    assert.equal(config.paypal.mode, "live");
    assert.equal(config.paypal.invoicingMode, "sandbox");
    assert.equal(envMod.getActiveInvoicingEnv().environment, "sandbox");
    assert.equal(config.paypal.invoicingActive.apiBaseUrl, "https://api-m.sandbox.paypal.com");

    process.env.PAYPAL_MODE = "sandbox";
    process.env.PAYPAL_INVOICING_MODE = "live";
    assert.equal(config.paypal.mode, "sandbox");
    assert.equal(envMod.getActiveInvoicingEnv().environment, "live");
    // Invoicing activation never changes the Checkout environment.
    assert.equal(envMod.getActivePayPalEnv().environment, "sandbox");
    assert.equal(config.paypal.invoicingActive.clientId, "live-test-client");
    assert.equal(config.paypal.invoicingWebhookConfigured, true);
});

test("invoicing LIVE without LIVE credentials fails closed and never falls back to Sandbox", () => {
    process.env.PAYPAL_INVOICING_MODE = "live";
    assert.throws(
        () => envMod.assertInvoicingEnvConfigured(),
        (err: { code?: string }) => err.code === "PAYPAL_INVOICING_NOT_CONFIGURED"
    );
});

test("webhook targets include Checkout and Invoicing ids per environment", () => {
    enableLiveCredentials();
    const targets = envMod.listWebhookCapablePayPalTargets();
    const key = (t: { environment: string; webhookKind: string; webhookId: string }) =>
        `${t.environment}:${t.webhookKind}:${t.webhookId}`;
    assert.deepEqual(targets.map(key), [
        "sandbox:checkout:WH-SB-CHECKOUT",
        "sandbox:invoicing:WH-SB-INVOICING",
        "live:invoicing:WH-LIVE-INVOICING",
    ]);
    assert.equal(targets.find((t) => t.environment === "live")?.clientId, "live-test-client");
});

test("webhook signature is verified against the invoicing webhook id", async () => {
    const client = await import("./paypal-client.js");
    const seen: string[] = [];
    globalThis.fetch = (async (urlLike: RequestInfo | URL, init?: RequestInit) => {
        const url = String(urlLike);
        if (url.endsWith("/v1/oauth2/token")) {
            return response({ access_token: "t", expires_in: 3600 });
        }
        const body = JSON.parse(String(init?.body));
        seen.push(body.webhook_id);
        return response({
            verification_status: body.webhook_id === "WH-SB-INVOICING" ? "SUCCESS" : "FAILURE",
        });
    }) as typeof fetch;
    const result = await client.verifyPayPalWebhookSignatureDetailed({
        headers: webhookHeaders,
        rawBody: JSON.stringify({ id: "WH-1", event_type: "INVOICING.INVOICE.PAID" }),
    });
    assert.equal(result.verified, true);
    assert.equal(result.environment, "sandbox");
    assert.equal(result.webhookKind, "invoicing");
    assert.deepEqual(seen, ["WH-SB-CHECKOUT", "WH-SB-INVOICING"]);
});

test("missing webhook configuration message mentions Checkout and Invoicing ids", async () => {
    const client = await import("./paypal-client.js");
    delete process.env.PAYPAL_SANDBOX_WEBHOOK_ID;
    delete process.env.PAYPAL_SANDBOX_INVOICING_WEBHOOK_ID;
    await assert.rejects(
        client.verifyPayPalWebhookSignatureDetailed({
            headers: webhookHeaders,
            rawBody: "{}",
        }),
        (err: Error) => /Checkout/.test(err.message) && /Invoicing/.test(err.message)
    );
});

test("createDraft requires explicit pricing confirmation", async () => {
    const s = await createShipment();
    installInvoicingMock();
    await assert.rejects(
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {}),
        (err: { code?: string }) => err.code === "INVOICE_PRICING_CONFIRM_REQUIRED"
    );
});

test("create draft sends PayPal-Request-Id, locks pricing, and mirrors the invoice", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(row.status, "DRAFT");
    assert.equal(row.environment, "sandbox");
    assert.equal(row.totalUsd, 1000);
    assert.equal(row.feeAmountUsd, 0);
    assert.match(row.paypalInvoiceId, /^INV2-TEST-/);

    const creates = mock.createCalls();
    assert.equal(creates.length, 1);
    assert.ok(creates[0].headers["paypal-request-id"], "PayPal-Request-Id header present");
    assert.match(creates[0].url, /^https:\/\/api-m\.sandbox\.paypal\.com\//);
    const items = (creates[0].body as { items: unknown[] }).items;
    assert.equal(items.length, 1);

    const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.ok(lead?.invoicePricingSnapshotJson, "pricing snapshot locked");
    assert.ok(lead?.invoiceNumber);

    const dbRow = await prisma.payPalCustomerInvoice.findUnique({
        where: { paypalInvoiceId: row.paypalInvoiceId },
    });
    assert.equal(dbRow?.createRequestId, creates[0].headers["paypal-request-id"]);
    const ops = await prisma.payPalInvoiceOperation.findMany();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].status, "SUCCEEDED");
    assert.equal(ops[0].requestId, dbRow?.createRequestId);

    const again = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(again.paypalInvoiceId, row.paypalInvoiceId);
    assert.equal(mock.createCalls().length, 1, "open invoice is reused, not recreated");
});

test("timeout before PayPal sees the request retries with the SAME PayPal-Request-Id", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    mock.behavior.createFailure = "before";
    mock.behavior.createFailureCount = 1;

    await assert.rejects(
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true }),
        (err: { code?: string }) => err.code === "PAYPAL_INVOICE_CREATE_UNCONFIRMED"
    );
    const pending = await prisma.payPalInvoiceOperation.findMany();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "PENDING");

    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    const creates = mock.createCalls();
    assert.equal(creates.length, 2, "failed attempt + retry");
    assert.equal(
        creates[0].headers["paypal-request-id"],
        creates[1].headers["paypal-request-id"],
        "retry must not mint a new key"
    );
    assert.equal(mock.invoices.size, 1);
    assert.equal(row.attemptCount, 2);
    const ops = await prisma.payPalInvoiceOperation.findMany();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].status, "SUCCEEDED");
});

test("timeout after PayPal created the invoice reconciles without a duplicate", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    mock.behavior.createFailure = "after";
    mock.behavior.createFailureCount = 1;

    await assert.rejects(
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true }),
        (err: { code?: string }) => err.code === "PAYPAL_INVOICE_CREATE_UNCONFIRMED"
    );
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(mock.invoices.size, 1, "exactly one remote invoice");
    assert.equal(await prisma.payPalCustomerInvoice.count(), 1);
    assert.equal(row.paypalInvoiceId, [...mock.invoices.keys()][0]);
    assert.ok(
        mock.calls.some((c) => c.url.includes("/search-invoices")),
        "retry searched PayPal before re-posting"
    );
});

test("concurrent creates converge on one invoice", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    const results = await Promise.all([
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true }),
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true }),
    ]);
    assert.equal(results[0].paypalInvoiceId, results[1].paypalInvoiceId);
    assert.equal(await prisma.payPalCustomerInvoice.count(), 1);
    assert.equal(mock.invoices.size, 1);
});

test("fee is off by default: single freight line item and total equals subtotal", async () => {
    const s = await createShipment({ customerRate: 1000 });
    const preview = await payPalInvoicingService.preview(actor, s.shipmentLeadId);
    assert.equal(preview.feeAmountUsd, 0);
    assert.equal(preview.feeType, "none");
    assert.equal(preview.totalUsd, 1000);
    assert.equal(preview.lineItems.length, 1);
    assert.equal(preview.environment, "sandbox");
});

test("PayPal invoice_number equals the load number (not INV- from GL)", async () => {
    const s = await createShipment({ customerRate: 100 });
    assert.match(String(s.loadNumber), /^GL/i);
    const mock = installInvoicingMock();
    const preview = await payPalInvoicingService.preview(actor, s.shipmentLeadId);
    assert.equal(preview.invoiceNumber, s.loadNumber);
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(row.greenOsInvoiceNumber, s.loadNumber);
    assert.equal(
        (mock.createCalls()[0].body as { detail: { invoice_number: string } }).detail.invoice_number,
        s.loadNumber
    );
    assert.ok(!String(row.greenOsInvoiceNumber).startsWith("INV-"));
});

test("percentage handling fee becomes a separate line item (never a PayPal surcharge)", async () => {
    await setFee("percentage", 3);
    const s = await createShipment({ customerRate: 1000 });
    const mock = installInvoicingMock();

    const preview = await payPalInvoicingService.preview(actor, s.shipmentLeadId);
    assert.equal(preview.subtotalUsd, 1000);
    assert.equal(preview.feeAmountUsd, 30);
    assert.equal(preview.totalUsd, 1030);

    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(row.feeType, "percentage");
    assert.equal(row.feeConfiguredValue, 3);
    assert.equal(row.feeDescription, "Handling fee");
    assert.equal(row.totalUsd, 1030);
    const items = (mock.createCalls()[0].body as {
        items: Array<{ name: string; unit_amount: { value: string } }>;
    }).items;
    assert.equal(items.length, 2);
    assert.equal(items[0].unit_amount.value, "1000.00");
    assert.equal(items[1].name, "Handling fee");
    assert.equal(items[1].unit_amount.value, "30.00");
    assert.ok(!items.some((i) => /paypal|surcharge/i.test(i.name)));
});

test("fixed handling fee line item", async () => {
    await setFee("fixed", 25);
    const s = await createShipment({ customerRate: 500 });
    const mock = installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(row.feeType, "fixed");
    assert.equal(row.feeAmountUsd, 25);
    assert.equal(row.totalUsd, 525);
    const items = (mock.createCalls()[0].body as { items: Array<{ unit_amount: { value: string } }> })
        .items;
    assert.deepEqual(
        items.map((i) => i.unit_amount.value),
        ["500.00", "25.00"]
    );
});

test("historical fee snapshot is immutable when pricing settings change", async () => {
    await setFee("percentage", 3);
    const s = await createShipment({ customerRate: 1000 });
    const mock = installInvoicingMock();
    const first = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(first.totalUsd, 1030);

    await setFee("percentage", 10);
    const preview = await payPalInvoicingService.preview(actor, s.shipmentLeadId);
    assert.equal(preview.pricingLocked, true);
    assert.equal(preview.feeAmountUsd, 30, "locked snapshot ignores the new 10% setting");
    assert.equal(preview.totalUsd, 1030);

    await payPalInvoicingService.cancel(actor, s.shipmentLeadId);
    const second = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(second.totalUsd, 1030, "re-created invoice reuses the locked snapshot");
    assert.equal(second.feeAmountUsd, 30);
    assert.notEqual(second.paypalInvoiceId, first.paypalInvoiceId);

    const stored = await prisma.payPalCustomerInvoice.findUnique({
        where: { paypalInvoiceId: first.paypalInvoiceId },
    });
    assert.equal(stored?.feeAmountUsd, 30, "historical row is unchanged");
    assert.equal(stored?.status, "CANCELLED");
    // Closed attempt keeps its key; the retry uses a distinct PayPal-Request-Id and invoice number.
    const creates = mock.createCalls();
    assert.equal(creates.length, 2);
    assert.notEqual(
        creates[0].headers["paypal-request-id"],
        creates[1].headers["paypal-request-id"]
    );
    assert.notEqual(
        (creates[0].body as any).detail.invoice_number,
        (creates[1].body as any).detail.invoice_number
    );
});

test("create is blocked when the customer is already paid or Checkout completed", async () => {
    const paid = await createShipment({ paid: true });
    installInvoicingMock();
    await assert.rejects(
        payPalInvoicingService.createDraft(actor, paid.shipmentLeadId, { confirmPricing: true }),
        (err: { code?: string }) => err.code === "CUSTOMER_ALREADY_PAID"
    );

    const s = await createShipment();
    await prisma.payPalCustomerOrder.create({
        data: {
            shipmentLeadId: s.shipmentLeadId,
            paypalOrderId: `ORDER-${Date.now()}`,
            environment: "sandbox",
            amountUsd: 1000,
            currency: "USD",
            status: "COMPLETED",
            paidAt: new Date(),
            idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
        },
    });
    await assert.rejects(
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true }),
        (err: { code?: string }) => err.code === "CHECKOUT_ALREADY_PAID"
    );
});

test("an open invoice with a different amount blocks a second open invoice", async () => {
    const s = await createShipment({ customerRate: 1000 });
    installInvoicingMock();
    await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true });
    await prisma.payPalCustomerInvoice.updateMany({
        where: { shipmentLeadId: s.shipmentLeadId },
        data: { totalUsd: 999 },
    });
    await assert.rejects(
        payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true }),
        (err: { code?: string }) => err.code === "PAYPAL_INVOICE_OPEN_EXISTS"
    );
});

test("sandbox invoice is never reused for a LIVE invoicing request", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    const sandboxRow = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(sandboxRow.environment, "sandbox");

    enableLiveCredentials();
    process.env.PAYPAL_INVOICING_MODE = "live";
    const liveRow = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    assert.equal(liveRow.environment, "live");
    assert.notEqual(liveRow.paypalInvoiceId, sandboxRow.paypalInvoiceId);
    assert.equal(liveRow.reused, false);
    const creates = mock.createCalls();
    assert.match(creates[0].url, /api-m\.sandbox\.paypal\.com/);
    assert.match(creates[1].url, /^https:\/\/api-m\.paypal\.com\//);
    assert.notEqual(
        creates[0].headers["paypal-request-id"],
        creates[1].headers["paypal-request-id"]
    );

    // A LIVE webhook can never mutate the sandbox invoice.
    const ignored = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "live",
        eventType: "INVOICING.INVOICE.CANCELLED",
        eventId: "WH-ENV",
        resource: { invoice: { id: sandboxRow.paypalInvoiceId, status: "CANCELLED" } },
    });
    assert.equal(ignored.result, "ignored_environment_mismatch");
    const stillOpen = await prisma.payPalCustomerInvoice.findUnique({
        where: { paypalInvoiceId: sandboxRow.paypalInvoiceId },
    });
    assert.equal(stillOpen?.status, "DRAFT");

    // Operations on the sandbox invoice keep targeting sandbox even while mode=live.
    mock.calls.length = 0;
    await payPalInvoicingService.cancel(actor, sandboxRow.paypalCustomerInvoiceId);
    assert.ok(mock.calls.some((c) => /api-m\.sandbox\.paypal\.com\/v2\/invoicing/.test(c.url)));
    assert.ok(!mock.calls.some((c) => /^https:\/\/api-m\.paypal\.com\/v2\/invoicing/.test(c.url)));
});

test("send moves a draft to SENT, stores the hosted URL, and marks the shipment INVOICE_SENT", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, { confirmPricing: true });
    const sent = await payPalInvoicingService.send(actor, s.shipmentLeadId);
    assert.equal(sent.status, "SENT");
    assert.match(String(sent.hostedInvoiceUrl), /paypal\.test\/invoice\/p\//);
    assert.ok(sent.sentAt);
    const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.equal(lead?.paymentStatus, "INVOICE_SENT");
    assert.equal(lead?.customerPaidAt, null);

    const again = await payPalInvoicingService.send(actor, s.shipmentLeadId);
    assert.equal(again.alreadySent, true);
    assert.equal(mock.calls.filter((c) => c.url.endsWith("/send")).length, 1);

    await payPalInvoicingService.remind(actor, s.shipmentLeadId);
    assert.ok(mock.calls.some((c) => c.url.endsWith("/remind")));
});

test("sync marks the shipment paid only for a PAID invoice with the exact amount, without record-payment", async () => {
    await setFee("percentage", 3);
    const s = await createShipment({ customerRate: 1000 });
    const mock = installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    await payPalInvoicingService.send(actor, s.shipmentLeadId);

    // Underpaid invoice flagged PAID in PayPal: never marks the shipment paid.
    mock.setStatus(row.paypalInvoiceId, "PAID", { paidValue: "1000.00" });
    const flagged = await payPalInvoicingService.sync(actor, s.shipmentLeadId);
    assert.equal(flagged.needsAccountingReview, true);
    assert.equal(flagged.paidAt, null);
    let lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.equal(lead?.customerPaidAt, null);
    assert.notEqual(lead?.paymentStatus, "CUSTOMER_PAID");

    mock.setStatus(row.paypalInvoiceId, "PAID", { paidValue: "1030.00", transactionId: "PAY-OK-9" });
    const paid = await payPalInvoicingService.sync(actor, s.shipmentLeadId);
    assert.equal(paid.status, "PAID");
    assert.ok(paid.paidAt);
    assert.equal(paid.paymentTransactionId, "PAY-OK-9");
    lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.equal(lead?.paymentStatus, "CUSTOMER_PAID");
    assert.ok(lead?.customerPaidAt);

    assert.ok(
        !mock.calls.some((c) => /record|payments/i.test(new URL(c.url).pathname.split("/v2/invoicing")[1] || "")),
        "PayPal-hosted payments never call record-payment"
    );
});

test("verified PAID webhook marks paid with matching amount; mismatched amount needs review", async () => {
    const good = await createShipment({ customerRate: 800 });
    const bad = await createShipment({ customerRate: 700 });
    const mock = installInvoicingMock();
    const goodRow = await payPalInvoicingService.createDraft(actor, good.shipmentLeadId, {
        confirmPricing: true,
    });
    const badRow = await payPalInvoicingService.createDraft(actor, bad.shipmentLeadId, {
        confirmPricing: true,
    });

    const mismatch = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.PAID",
        eventId: "WH-PAID-BAD",
        resource: {
            invoice: {
                id: badRow.paypalInvoiceId,
                status: "PAID",
                amount: { currency_code: "USD", value: "700.00" },
                payments: {
                    paid_amount: { currency_code: "USD", value: "699.99" },
                    transactions: [{ payment_id: "PAY-BAD" }],
                },
            },
        },
    });
    assert.equal(mismatch.result, "paid_amount_mismatch_review");
    const badLead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: bad.shipmentLeadId },
    });
    assert.equal(badLead?.customerPaidAt, null);
    const badInvoice = await prisma.payPalCustomerInvoice.findUnique({
        where: { paypalInvoiceId: badRow.paypalInvoiceId },
    });
    assert.equal(badInvoice?.needsAccountingReview, true);
    assert.equal(badInvoice?.paidAt, null);

    const ok = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.PAID",
        eventId: "WH-PAID-OK",
        resource: {
            invoice: {
                id: goodRow.paypalInvoiceId,
                status: "PAID",
                amount: { currency_code: "USD", value: "800.00" },
                payments: {
                    paid_amount: { currency_code: "USD", value: "800.00" },
                    transactions: [{ payment_id: "PAY-GOOD" }],
                },
            },
        },
    });
    assert.equal(ok.result, "paid");
    const goodLead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: good.shipmentLeadId },
    });
    assert.equal(goodLead?.paymentStatus, "CUSTOMER_PAID");
    assert.ok(goodLead?.customerPaidAt);

    mock.setStatus(goodRow.paypalInvoiceId, "PAID", { paidValue: "800.00" });
    const replay = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.PAID",
        eventId: "WH-PAID-OK-2",
        resource: { invoice: { id: goodRow.paypalInvoiceId, status: "PAID" } },
    });
    assert.equal(replay.result, "already_paid");
    assert.equal(mock.calls.filter((c) => c.url.includes("record")).length, 0);
});

test("PAID webhook without amounts falls back to GET and still verifies the amount", async () => {
    const s = await createShipment({ customerRate: 450 });
    const mock = installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    mock.setStatus(row.paypalInvoiceId, "PAID", { paidValue: "450.00" });
    const result = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.PAID",
        eventId: "WH-NOAMT",
        resource: { id: row.paypalInvoiceId },
    });
    assert.equal(result.result, "paid");
});

test("stale events never reopen a cancelled invoice; cancelled/refunded are mirrored", async () => {
    const s = await createShipment({ customerRate: 300 });
    installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    const cancelled = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.CANCELLED",
        eventId: "WH-C1",
        resource: { invoice: { id: row.paypalInvoiceId } },
    });
    assert.equal(cancelled.result, "cancelled");
    const stale = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.UPDATED",
        eventId: "WH-C2",
        resource: { invoice: { id: row.paypalInvoiceId, status: "SENT" } },
    });
    assert.match(stale.result, /^ignored_/);
    const stored = await prisma.payPalCustomerInvoice.findUnique({
        where: { paypalInvoiceId: row.paypalInvoiceId },
    });
    assert.equal(stored?.status, "CANCELLED");
    assert.ok(stored?.cancelledAt);

    const unknown = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.PAID",
        eventId: "WH-U",
        resource: { invoice: { id: "INV2-NOT-OURS", status: "PAID" } },
    });
    assert.equal(unknown.result, "ignored_unknown_invoice");
});

test("refunded invoice reverts a customer-paid shipment to CUSTOMER_REFUNDED", async () => {
    const s = await createShipment({ customerRate: 200 });
    const mock = installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    mock.setStatus(row.paypalInvoiceId, "PAID");
    await payPalInvoicingService.sync(actor, s.shipmentLeadId);
    const refunded = await payPalInvoicingService.handleInvoicingWebhookEvent({
        environment: "sandbox",
        eventType: "INVOICING.INVOICE.REFUNDED",
        eventId: "WH-R",
        resource: { invoice: { id: row.paypalInvoiceId, status: "REFUNDED" } },
    });
    assert.equal(refunded.result, "refunded");
    const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.equal(lead?.paymentStatus, "CUSTOMER_REFUNDED");
    assert.equal(lead?.customerPaidAt, null);
});

test("webhook dispatcher routes INVOICING.* events to the invoicing service and records the invoice id", async () => {
    const s = await createShipment({ customerRate: 600 });
    installInvoicingMock();
    const row = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    const rawBody = JSON.stringify({
        id: "WH-DISPATCH-1",
        event_type: "INVOICING.INVOICE.PAID",
        resource: {
            invoice: {
                id: row.paypalInvoiceId,
                status: "PAID",
                amount: { currency_code: "USD", value: "600.00" },
                payments: {
                    paid_amount: { currency_code: "USD", value: "600.00" },
                    transactions: [{ payment_id: "PAY-D1" }],
                },
            },
        },
    });
    const result = await payPalCheckoutService.handleWebhook({ headers: webhookHeaders, rawBody });
    assert.equal(result.result, "paid");
    const event = await prisma.payPalWebhookEvent.findUnique({ where: { eventId: "WH-DISPATCH-1" } });
    assert.equal(event?.paypalInvoiceId, row.paypalInvoiceId);
    assert.equal(event?.paypalOrderId, null);
    assert.equal(event?.processed, true);
    assert.equal(event?.environment, "sandbox");

    const dup = await payPalCheckoutService.handleWebhook({ headers: webhookHeaders, rawBody });
    assert.equal(dup.duplicate, true);
    const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.equal(lead?.paymentStatus, "CUSTOMER_PAID");
});

test("cancel uses delete for drafts and cancel API for sent invoices", async () => {
    const draftShipment = await createShipment({ customerRate: 100 });
    const sentShipment = await createShipment({ customerRate: 120 });
    const mock = installInvoicingMock();
    await payPalInvoicingService.createDraft(actor, draftShipment.shipmentLeadId, {
        confirmPricing: true,
    });
    const cancelledDraft = await payPalInvoicingService.cancel(actor, draftShipment.shipmentLeadId);
    assert.equal(cancelledDraft.status, "CANCELLED");
    assert.ok(mock.calls.some((c) => c.method === "DELETE"));

    await payPalInvoicingService.createDraft(actor, sentShipment.shipmentLeadId, {
        confirmPricing: true,
    });
    await payPalInvoicingService.send(actor, sentShipment.shipmentLeadId);
    const cancelledSent = await payPalInvoicingService.cancel(
        actor,
        sentShipment.shipmentLeadId,
        "Customer requested"
    );
    assert.equal(cancelledSent.status, "CANCELLED");
    assert.ok(mock.calls.some((c) => c.url.endsWith("/cancel")));
});

test("invoicing requires BillingSend permission", async () => {
    const s = await createShipment();
    await assert.rejects(
        payPalInvoicingService.preview(
            { userId: "viewer", role: "Agent", accountingSubRole: null },
            s.shipmentLeadId
        ),
        (err: { status?: number }) => err.status === 403
    );
});

test("safety helpers: open/terminal statuses, reuse rules, exact-cents paid check", () => {
    for (const status of ["DRAFT", "SENT", "SCHEDULED", "UNPAID", "PAYMENT_PENDING", "PARTIALLY_PAID"]) {
        assert.equal(safety.isOpenPayPalInvoiceStatus(status), true, status);
    }
    for (const status of ["PAID", "MARKED_AS_PAID", "CANCELLED", "REFUNDED"]) {
        assert.equal(safety.isTerminalPayPalInvoiceStatus(status), true, status);
        assert.equal(safety.isOpenPayPalInvoiceStatus(status), false, status);
    }
    const row = { status: "SENT", environment: "sandbox", totalUsd: 10.1, currency: "USD", greenOsInvoiceNumber: "INV-1" };
    const want = { environment: "sandbox", totalUsd: 10.1, currency: "USD", invoiceNumber: "INV-1" };
    assert.equal(safety.isReusableOpenPayPalInvoice(row, want), true);
    assert.equal(safety.isReusableOpenPayPalInvoice(row, { ...want, environment: "live" }), false);
    assert.equal(safety.isReusableOpenPayPalInvoice(row, { ...want, totalUsd: 10.11 }), false);
    assert.equal(safety.isReusableOpenPayPalInvoice(row, { ...want, invoiceNumber: "INV-2" }), false);
    assert.equal(safety.isReusableOpenPayPalInvoice({ ...row, status: "CANCELLED" }, want), false);

    assert.deepEqual(
        safety.verifyInvoicePaidAmount({
            expectedTotalUsd: 1030,
            currency: "USD",
            invoiceAmount: { value: "1030.00", currency_code: "USD" },
        }),
        { amountUsd: 1030, currency: "USD" }
    );
    assert.throws(
        () =>
            safety.verifyInvoicePaidAmount({
                expectedTotalUsd: 1030,
                currency: "USD",
                invoiceAmount: { value: "1030.01", currency_code: "USD" },
            }),
        (err: { code?: string }) => err.code === "PAYPAL_INVOICE_AMOUNT_MISMATCH"
    );
    assert.throws(
        () =>
            safety.verifyInvoicePaidAmount({
                expectedTotalUsd: 10,
                currency: "USD",
                invoiceAmount: { value: "10.00", currency_code: "EUR" },
            }),
        (err: { code?: string }) => err.code === "PAYPAL_INVOICE_CURRENCY_MISMATCH"
    );

    const k0 = safety.invoicingAttemptKey("ship", 1000, "INV-1", "sandbox", 0);
    assert.equal(k0, safety.invoicingAttemptKey("ship", 1000, "INV-1", "sandbox", 0));
    assert.notEqual(k0, safety.invoicingAttemptKey("ship", 1000, "INV-1", "live", 0));
    assert.notEqual(k0, safety.invoicingAttemptKey("ship", 1000, "INV-1", "sandbox", 1));
    assert.notEqual(k0, safety.invoicingAttemptKey("ship", 1001, "INV-1", "sandbox", 0));

    assert.equal(safety.isAmbiguousPayPalFailure(new TypeError("fetch failed")), true);
    assert.equal(safety.isAmbiguousPayPalFailure({ paypalStatus: 503 }), true);
    assert.equal(safety.isAmbiguousPayPalFailure({ paypalStatus: 422 }), false);
    assert.equal(safety.payPalInvoiceNumberForAttempt("INV-1", 0), "INV-1");
    assert.equal(safety.payPalInvoiceNumberForAttempt("INV-1", 1), "INV-1-R2");
    assert.ok(safety.payPalInvoiceNumberForAttempt("X".repeat(40), 3).length <= 25);
});

test("invoice payload builder never enables partial payment, tips, or tax", async () => {
    const { buildPayPalInvoicePayload, immediateInvoiceIssueDate, calendarDateInTimeZone } =
        await import("./paypal-invoicing-client.js");
    const body = buildPayPalInvoicePayload({
        invoiceNumber: "INV-9",
        invoiceDate: new Date("2026-11-16T10:00:00Z"),
        dueDate: new Date("2026-12-16T10:00:00Z"),
        customerName: "Acme",
        customerEmail: "ap@acme.test",
        items: [{ name: "Freight", quantity: 1, unitAmount: 12.5 }],
        reference: "GL10001",
    });
    assert.equal(body.detail.invoice_date, "2026-11-16");
    assert.equal(body.detail.payment_term.due_date, "2026-12-16");
    assert.equal(body.items[0].unit_amount.value, "12.50");
    assert.equal(body.configuration.partial_payment.allow_partial_payment, false);
    assert.equal(body.configuration.allow_tip, false);
    assert.equal(body.primary_recipients[0].billing_info.email_address, "ap@acme.test");

    const now = new Date("2026-11-17T02:00:00Z");
    assert.equal(immediateInvoiceIssueDate(now), "2026-11-16");
    // Yerevan is UTC+4 — early UTC morning is already next calendar day locally.
    assert.equal(
        calendarDateInTimeZone(new Date("2026-11-16T22:30:00Z"), "Asia/Yerevan"),
        "2026-11-17"
    );
});

test("send rewrites a future issue date and force-emails SCHEDULED invoices", async () => {
    const s = await createShipment();
    const mock = installInvoicingMock();
    const created = await payPalInvoicingService.createDraft(actor, s.shipmentLeadId, {
        confirmPricing: true,
    });
    // Simulate the LIVE bug: merchant TZ treated invoice_date as future → SCHEDULED.
    const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const inv = mock.invoices.get(created.paypalInvoiceId)!;
    inv.status = "SCHEDULED";
    inv.body.detail.invoice_date = tomorrow;
    await prisma.payPalCustomerInvoice.update({
        where: { paypalInvoiceId: created.paypalInvoiceId },
        data: { status: "SCHEDULED" },
    });

    const sent = await payPalInvoicingService.send(actor, s.shipmentLeadId);
    assert.equal(sent.status, "SENT");
    assert.ok(sent.sentAt);
    assert.ok(mock.calls.some((c) => c.method === "PUT" && c.url.includes(created.paypalInvoiceId)));
    assert.ok(mock.calls.some((c) => c.url.endsWith("/send")));
    const afterPut = mock.invoices.get(created.paypalInvoiceId)!;
    assert.ok(afterPut.body.detail.invoice_date <= new Date().toISOString().slice(0, 10));
    const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId: s.shipmentLeadId } });
    assert.equal(lead?.paymentStatus, "INVOICE_SENT");
});

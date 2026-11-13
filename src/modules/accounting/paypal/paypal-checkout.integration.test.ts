import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const tempDir = mkdtempSync(path.join(tmpdir(), "greenos-paypal-safety-"));
const dbPath = path.join(tempDir, "test.db");
const originalFetch = globalThis.fetch;

let prisma: typeof import("../../../config/database.js").prisma;
let payPalCheckoutService: typeof import("./paypal-checkout.service.js").payPalCheckoutService;
let accountingService: typeof import("../services/accounting.service.js").accountingService;
let clearPayPalTokenCache: typeof import("./paypal-client.js").clearPayPalTokenCache;

const billingActor = {
    userId: "test-owner",
    role: "Owner",
    accountingSubRole: null,
};

function response(json: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status >= 200 && status < 300 ? "OK" : "ERROR",
        json: async () => json,
        text: async () => JSON.stringify(json),
    } as Response;
}

function installPayPalMock(input: {
    orderStatus?: string;
    captureStatus?: string | null;
    captureId?: string | null;
    amount?: string;
    currency?: string;
    captureDelayMs?: number;
}) {
    let captureCalls = 0;
    let verifyCalls = 0;
    const orderStatus = input.orderStatus || "APPROVED";
    globalThis.fetch = (async (urlLike: RequestInfo | URL) => {
        const url = String(urlLike);
        if (url.endsWith("/v1/oauth2/token")) {
            return response({ access_token: "sandbox-test-token", expires_in: 3600 });
        }
        if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
            verifyCalls += 1;
            return response({ verification_status: "SUCCESS" });
        }
        if (url.endsWith("/capture")) {
            captureCalls += 1;
            if (input.captureDelayMs) {
                await new Promise((resolve) => setTimeout(resolve, input.captureDelayMs));
            }
            const capture =
                input.captureStatus == null
                    ? []
                    : [
                          {
                              id: input.captureId || "CAP-TEST",
                              status: input.captureStatus,
                              amount: {
                                  value: input.amount || "100.00",
                                  currency_code: input.currency || "USD",
                              },
                          },
                      ];
            return response({
                id: "ORDER-TEST",
                status:
                    input.captureStatus === "COMPLETED"
                        ? "COMPLETED"
                        : orderStatus,
                purchase_units: [{ payments: { captures: capture } }],
            });
        }
        if (url.includes("/v2/checkout/orders/")) {
            const capture =
                orderStatus === "COMPLETED" && input.captureStatus
                    ? [
                          {
                              id: input.captureId || "CAP-TEST",
                              status: input.captureStatus,
                              amount: {
                                  value: input.amount || "100.00",
                                  currency_code: input.currency || "USD",
                              },
                          },
                      ]
                    : [];
            return response({
                id: "ORDER-TEST",
                status: orderStatus,
                purchase_units: [{ payments: { captures: capture } }],
            });
        }
        throw new Error(`Unexpected PayPal test URL: ${url}`);
    }) as typeof fetch;
    return {
        get captureCalls() {
            return captureCalls;
        },
        get verifyCalls() {
            return verifyCalls;
        },
    };
}

async function createPayment(input?: {
    status?: string;
    paid?: boolean;
    paymentMethod?: string;
}) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const paidAt = input?.paid ? new Date() : null;
    const shipment = await prisma.shipmentLead.create({
        data: {
            source: "TEST",
            shipmentTitle: `PayPal safety ${suffix}`,
            customerName: "Sandbox Customer",
            customerEmail: "sandbox@example.test",
            customerRate: 100,
            accessorialCharges: 0,
            customerPaymentMethod: input?.paymentMethod || "PAYPAL",
            invoiceNumber: `INV-${suffix}`,
            accountingReadyForBilling: true,
            customerPaidAt: paidAt,
            paymentStatus: paidAt ? "CUSTOMER_PAID" : "INVOICE_SENT",
        },
    });
    const payment = await prisma.payPalCustomerOrder.create({
        data: {
            shipmentLeadId: shipment.shipmentLeadId,
            paypalOrderId: "ORDER-TEST",
            invoiceNumber: shipment.invoiceNumber,
            customerName: shipment.customerName,
            customerEmail: shipment.customerEmail,
            amountUsd: 100,
            currency: "USD",
            status: input?.status || "APPROVED",
            approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-TEST",
            idempotencyKey: `idem-${suffix}`,
            paidAt,
            captureId: paidAt ? "CAP-TEST" : null,
            captureCompletedAt: paidAt,
        },
    });
    return { shipment, payment };
}

const webhookHeaders = {
    "paypal-transmission-id": "transmission-test",
    "paypal-transmission-time": "2026-11-14T00:00:00Z",
    "paypal-cert-url": "https://api-m.sandbox.paypal.com/cert.pem",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "test-signature",
};

before(async () => {
    process.env.DATABASE_URL = `file:${dbPath}`;
    process.env.PAYPAL_MODE = "sandbox";
    process.env.PAYPAL_CLIENT_ID = "sandbox-test-client";
    process.env.PAYPAL_CLIENT_SECRET = "sandbox-test-secret";
    process.env.PAYPAL_WEBHOOK_ID = "WH-SANDBOX-TEST";
    execFileSync(
        "npx",
        ["prisma", "db", "push", "--skip-generate"],
        {
            cwd: path.resolve("."),
            env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
            stdio: "ignore",
        }
    );
    ({ prisma } = await import("../../../config/database.js"));
    ({ payPalCheckoutService } = await import("./paypal-checkout.service.js"));
    ({ accountingService } = await import("../services/accounting.service.js"));
    ({ clearPayPalTokenCache } = await import("./paypal-client.js"));
});

beforeEach(async () => {
    globalThis.fetch = originalFetch;
    clearPayPalTokenCache();
    await prisma.payPalWebhookEvent.deleteMany();
    await prisma.payPalCustomerOrder.deleteMany();
    await prisma.shipmentLead.deleteMany({ where: { source: "TEST" } });
});

after(async () => {
    globalThis.fetch = originalFetch;
    await prisma.$disconnect();
    rmSync(tempDir, { recursive: true, force: true });
});

test("successful COMPLETED capture marks shipment CUSTOMER_PAID", async () => {
    const { shipment } = await createPayment();
    installPayPalMock({ captureStatus: "COMPLETED" });
    const payment = await payPalCheckoutService.captureAndMarkPaid(
        "ORDER-TEST",
        billingActor
    );
    assert.equal(payment.status, "COMPLETED");
    assert.equal(payment.captureId, "CAP-TEST");
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.paymentStatus, "CUSTOMER_PAID");
    assert.ok(lead?.customerPaidAt);
});

test("APPROVED order without successful capture becomes FAILED and remains unpaid", async () => {
    const { shipment } = await createPayment();
    installPayPalMock({ captureStatus: null, orderStatus: "APPROVED" });
    const payment = await payPalCheckoutService.captureAndMarkPaid("ORDER-TEST");
    assert.equal(payment.status, "FAILED");
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.customerPaidAt, null);
});

for (const status of ["PENDING", "DENIED"]) {
    test(`capture ${status} remains unpaid even with capture id`, async () => {
        const { shipment } = await createPayment();
        installPayPalMock({ captureStatus: status, captureId: "CAP-EXISTS" });
        const payment = await payPalCheckoutService.captureAndMarkPaid("ORDER-TEST");
        assert.equal(
            payment.status,
            status === "PENDING" ? "CAPTURE_PENDING" : "DENIED"
        );
        assert.equal(payment.captureId, "CAP-EXISTS");
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: shipment.shipmentLeadId },
        });
        assert.equal(lead?.customerPaidAt, null);
    });
}

test("simultaneous capture requests call PayPal Capture once", async () => {
    await createPayment();
    const mock = installPayPalMock({
        captureStatus: "COMPLETED",
        captureDelayMs: 50,
    });
    await Promise.all([
        payPalCheckoutService.captureAndMarkPaid("ORDER-TEST"),
        payPalCheckoutService.captureAndMarkPaid("ORDER-TEST"),
    ]);
    assert.equal(mock.captureCalls, 1);
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    assert.equal(payment?.status, "COMPLETED");
    assert.ok(payment?.captureRequestId);
    assert.ok(payment?.captureStartedAt);
    assert.ok(payment?.captureCompletedAt);
});

test("wrong capture amount or currency never marks paid", async () => {
    const { shipment } = await createPayment();
    installPayPalMock({
        captureStatus: "COMPLETED",
        amount: "99.99",
        currency: "EUR",
    });
    await assert.rejects(
        () => payPalCheckoutService.captureAndMarkPaid("ORDER-TEST"),
        (err: { code?: string }) =>
            err.code === "PAYPAL_CAPTURE_CURRENCY_MISMATCH" ||
            err.code === "PAYPAL_CAPTURE_AMOUNT_MISMATCH"
    );
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.customerPaidAt, null);
});

test("PAYMENT.CAPTURE.COMPLETED webhook finalizes once and replay is ignored", async () => {
    const { shipment } = await createPayment({ status: "CAPTURE_PENDING" });
    const mock = installPayPalMock({
        orderStatus: "COMPLETED",
        captureStatus: "COMPLETED",
    });
    const rawBody = JSON.stringify({
        id: "WH-EVENT-COMPLETED",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
            id: "CAP-TEST",
            status: "COMPLETED",
            amount: { value: "100.00", currency_code: "USD" },
            supplementary_data: { related_ids: { order_id: "ORDER-TEST" } },
        },
    });
    const first = await payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody,
    });
    const replay = await payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody,
    });
    assert.equal(first.result, "completed");
    assert.equal(replay.duplicate, true);
    assert.equal(mock.captureCalls, 0);
    // Every delivery, including a replay, is signature-verified before dedupe.
    assert.equal(mock.verifyCalls, 2);
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.paymentStatus, "CUSTOMER_PAID");
});

test("CHECKOUT.ORDER.APPROVED webhook never executes capture", async () => {
    await createPayment({ status: "CREATED" });
    const mock = installPayPalMock({ orderStatus: "APPROVED" });
    const result = await payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody: JSON.stringify({
            id: "WH-EVENT-APPROVED",
            event_type: "CHECKOUT.ORDER.APPROVED",
            resource: { id: "ORDER-TEST", status: "APPROVED" },
        }),
    });
    assert.equal(result.result, "approved");
    assert.equal(mock.captureCalls, 0);
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    assert.equal(payment?.status, "APPROVED");
    assert.equal(payment?.paidAt, null);
});

test("completed webhook with wrong amount is rejected and remains unpaid", async () => {
    const { shipment } = await createPayment({ status: "CAPTURE_PENDING" });
    installPayPalMock({
        orderStatus: "COMPLETED",
        captureStatus: "COMPLETED",
    });
    await assert.rejects(
        () =>
            payPalCheckoutService.handleWebhook({
                headers: webhookHeaders,
                rawBody: JSON.stringify({
                    id: "WH-EVENT-WRONG-AMOUNT",
                    event_type: "PAYMENT.CAPTURE.COMPLETED",
                    resource: {
                        id: "CAP-TEST",
                        status: "COMPLETED",
                        amount: { value: "99.99", currency_code: "USD" },
                        supplementary_data: {
                            related_ids: { order_id: "ORDER-TEST" },
                        },
                    },
                }),
            }),
        (err: { code?: string }) => err.code === "PAYPAL_CAPTURE_AMOUNT_MISMATCH"
    );
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.customerPaidAt, null);
});

test("invalid webhook signature is rejected before processing", async () => {
    await createPayment();
    await assert.rejects(
        () =>
            payPalCheckoutService.handleWebhook({
                headers: {},
                rawBody: JSON.stringify({
                    id: "WH-BAD-SIG",
                    event_type: "PAYMENT.CAPTURE.COMPLETED",
                }),
            }),
        (err: { code?: string }) => err.code === "PAYPAL_WEBHOOK_INVALID"
    );
    assert.equal(await prisma.payPalWebhookEvent.count(), 0);
});

test("refund webhook changes payment and shipment to refunded state", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const result = await payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody: JSON.stringify({
            id: "WH-EVENT-REFUND",
            event_type: "PAYMENT.CAPTURE.REFUNDED",
            resource: {
                id: "REFUND-1",
                status: "COMPLETED",
                amount: { value: "100.00", currency_code: "USD" },
                supplementary_data: { related_ids: { order_id: "ORDER-TEST" } },
            },
        }),
    });
    assert.equal(result.result, "refunded");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REFUNDED");
    assert.equal(lead?.customerPaidAt, null);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REFUNDED");
});

test("manual payment endpoint rejects unauthorized role and PayPal bypass", async () => {
    const { shipment } = await createPayment();
    await assert.rejects(
        () =>
            accountingService.recordCustomerPayment(
                {
                    userId: "documents-user",
                    role: "Accounting",
                    accountingSubRole: "DOCUMENTS",
                },
                shipment.shipmentLeadId
            ),
        (err: { status?: number }) => err.status === 403
    );
    await assert.rejects(
        () =>
            accountingService.recordCustomerPayment(
                {
                    userId: "payments-user",
                    role: "Accounting",
                    accountingSubRole: "PAYMENTS",
                },
                shipment.shipmentLeadId
            ),
        (err: { code?: string }) => err.code === "PAYPAL_MANUAL_PAYMENT_BLOCKED"
    );
});

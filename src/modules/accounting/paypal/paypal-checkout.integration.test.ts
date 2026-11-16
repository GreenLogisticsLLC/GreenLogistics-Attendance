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
    createOrderId?: string;
    createApprovalUrl?: string;
}) {
    let captureCalls = 0;
    let verifyCalls = 0;
    let createCalls = 0;
    const orderStatus = input.orderStatus || "APPROVED";
    const orderIdForGets = input.createOrderId || "ORDER-TEST";
    globalThis.fetch = (async (urlLike: RequestInfo | URL, init?: RequestInit) => {
        const url = String(urlLike);
        if (url.endsWith("/v1/oauth2/token")) {
            return response({ access_token: "sandbox-test-token", expires_in: 3600 });
        }
        if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
            verifyCalls += 1;
            return response({ verification_status: "SUCCESS" });
        }
        if (url.endsWith("/v2/checkout/orders") && String(init?.method || "GET").toUpperCase() === "POST") {
            createCalls += 1;
            const id = input.createOrderId || `ORDER-NEW-${createCalls}`;
            return response({
                id,
                status: "CREATED",
                links: [
                    {
                        rel: "approve",
                        href:
                            input.createApprovalUrl ||
                            `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
                    },
                ],
            });
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
                id: orderIdForGets,
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
                id: orderIdForGets,
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
        get createCalls() {
            return createCalls;
        },
    };
}

async function applyWebhook(eventType: string, eventId: string, resource: Record<string, unknown>) {
    return payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody: JSON.stringify({
            id: eventId,
            event_type: eventType,
            resource: {
                amount: { value: "100.00", currency_code: "USD" },
                supplementary_data: { related_ids: { order_id: "ORDER-TEST" } },
                ...resource,
            },
        }),
    });
}

async function reverseCompletedPayment() {
    const created = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const reversed = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-BASE", {
        id: "CAP-TEST",
        status: "REVERSED",
    });
    assert.equal(reversed.result, "reversed");
    return created;
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
            // Waive fee so quote.total === 100 and matches order/webhook fixtures.
            customerPaymentMethod: input?.paymentMethod || "PAYPAL",
            waiveCustomerPaymentFee: true,
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
            environment: "sandbox",
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

test("PAYMENT.CAPTURE.REVERSED clears paid and flags Accounting review", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const first = await payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody: JSON.stringify({
            id: "WH-EVENT-REVERSE",
            event_type: "PAYMENT.CAPTURE.REVERSED",
            resource: {
                id: "CAP-TEST",
                status: "REVERSED",
                amount: { value: "100.00", currency_code: "USD" },
                supplementary_data: { related_ids: { order_id: "ORDER-TEST" } },
            },
        }),
    });
    assert.equal(first.result, "reversed");
    assert.equal(first.environment, "sandbox");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(payment?.needsAccountingReview, true);
    assert.ok(payment?.reversedAt);
    assert.equal(payment?.paidAt, null);
    assert.equal(lead?.customerPaidAt, null);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");

    const replay = await payPalCheckoutService.handleWebhook({
        headers: webhookHeaders,
        rawBody: JSON.stringify({
            id: "WH-EVENT-REVERSE",
            event_type: "PAYMENT.CAPTURE.REVERSED",
            resource: {
                id: "CAP-TEST",
                status: "REVERSED",
                supplementary_data: { related_ids: { order_id: "ORDER-TEST" } },
            },
        }),
    });
    assert.equal(replay.duplicate, true);
});

test("stale APPROVED/PENDING/DENIED/VOIDED/COMPLETED cannot overwrite REVERSED", async () => {
    const { shipment } = await reverseCompletedPayment();
    const cases: Array<{ type: string; id: string }> = [
        { type: "CHECKOUT.ORDER.APPROVED", id: "WH-STALE-APPROVED" },
        { type: "PAYMENT.CAPTURE.PENDING", id: "WH-STALE-PENDING" },
        { type: "PAYMENT.CAPTURE.DENIED", id: "WH-STALE-DENIED" },
        { type: "CHECKOUT.ORDER.VOIDED", id: "WH-STALE-VOIDED" },
        {
            type: "PAYMENT.CAPTURE.COMPLETED",
            id: "WH-STALE-COMPLETED",
        },
    ];
    for (const c of cases) {
        installPayPalMock({
            orderStatus: "COMPLETED",
            captureStatus: "COMPLETED",
            captureId: "CAP-TEST",
        });
        const result = await applyWebhook(c.type, c.id, {
            id: c.type === "CHECKOUT.ORDER.APPROVED" ? "ORDER-TEST" : "CAP-TEST",
            status: c.type.includes("COMPLETED") ? "COMPLETED" : "PENDING",
        });
        assert.match(
            String(result.result),
            /ignored_terminal|already_reversed|ignored_terminal_or_missing/
        );
    }
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(payment?.needsAccountingReview, true);
    assert.ok(payment?.reversedAt);
    assert.equal(payment?.paidAt, null);
    assert.equal(payment?.captureId, "CAP-TEST");
    assert.equal(lead?.customerPaidAt, null);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
});

test("repeated REVERSED event is idempotent and keeps Accounting review", async () => {
    const { shipment } = await reverseCompletedPayment();
    installPayPalMock({});
    const again = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-AGAIN", {
        id: "CAP-TEST",
        status: "REVERSED",
    });
    assert.equal(again.result, "already_reversed");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(payment?.needsAccountingReview, true);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
});

test("regenerate after REVERSED creates a separate attempt without erasing history", async () => {
    const { shipment, payment: reversedRow } = await reverseCompletedPayment();
    const priorReversalId = (
        await prisma.payPalCustomerOrder.findUnique({
            where: { paypalCustomerOrderId: reversedRow.paypalCustomerOrderId },
        })
    )?.reversalId;
    installPayPalMock({
        createOrderId: "ORDER-RETRY-1",
        createApprovalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-RETRY-1",
    });
    const generated = await payPalCheckoutService.generatePaymentLink(
        billingActor,
        shipment.shipmentLeadId
    );
    assert.equal(generated.paypalOrderId, "ORDER-RETRY-1");
    assert.notEqual(generated.paypalCustomerOrderId, reversedRow.paypalCustomerOrderId);
    assert.equal(generated.captureId, null);
    assert.equal(generated.status, "CREATED");
    assert.equal(generated.needsAccountingReview, false);
    assert.equal(generated.reversedAt, null);

    const historical = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalCustomerOrderId: reversedRow.paypalCustomerOrderId },
    });
    assert.equal(historical?.status, "REVERSED");
    assert.equal(historical?.captureId, "CAP-TEST");
    assert.equal(historical?.reversalId, priorReversalId || "CAP-TEST");
    assert.equal(historical?.needsAccountingReview, true);
    assert.ok(historical?.reversedAt);

    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);

    const openCount = await prisma.payPalCustomerOrder.count({
        where: {
            shipmentLeadId: shipment.shipmentLeadId,
            status: { in: ["CREATED", "APPROVED", "CAPTURE_PENDING"] },
        },
    });
    assert.equal(openCount, 1);
});

test("REFUNDED after REVERSED keeps REVERSED final state and records refund facts", async () => {
    const { shipment } = await reverseCompletedPayment();
    installPayPalMock({});
    const refund = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-REFUND-AFTER-REV", {
        id: "REFUND-AFTER",
        status: "COMPLETED",
    });
    assert.equal(refund.result, "refund_recorded_on_reversed");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(payment?.needsAccountingReview, true);
    assert.ok(payment?.reversedAt);
    assert.equal(payment?.refundId, "REFUND-AFTER");
    assert.ok(payment?.refundedAt);
    assert.equal(payment?.paidAt, null);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
});

test("REVERSED after REFUNDED upgrades to REVERSED and preserves refund facts", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const refund = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-REFUND-FIRST", {
        id: "REFUND-FIRST",
        status: "COMPLETED",
    });
    assert.equal(refund.result, "refunded");
    const reverse = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-AFTER-REFUND", {
        id: "CAP-TEST",
        status: "REVERSED",
    });
    assert.equal(reverse.result, "reversed");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(payment?.refundId, "REFUND-FIRST");
    assert.ok(payment?.refundedAt);
    assert.ok(payment?.reversedAt);
    assert.equal(payment?.needsAccountingReview, true);
    assert.equal(payment?.paidAt, null);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
});

test("finalize loses to concurrent REVERSED and never leaves CUSTOMER_PAID", async () => {
    const { shipment, payment } = await createPayment({ status: "CAPTURE_PENDING", paid: false });
    installPayPalMock({
        orderStatus: "COMPLETED",
        captureStatus: "COMPLETED",
        captureId: "CAP-TEST",
    });
    const reversePromise = applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-RACE-REV", {
        id: "CAP-TEST",
        status: "REVERSED",
    });
    const finalizePromise = payPalCheckoutService.captureAndMarkPaid(
        payment.paypalOrderId,
        billingActor
    );
    const results = await Promise.allSettled([reversePromise, finalizePromise]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    const order = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    if (order?.status === "REVERSED" || order?.reversedAt) {
        assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
        assert.equal(lead?.customerPaidAt, null);
        assert.equal(order.needsAccountingReview, true);
    } else {
        // Capture won first — a later reverse must still clear paid.
        await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-RACE-REV-LATE", {
            id: "CAP-TEST",
            status: "REVERSED",
        });
    }
    const finalOrder = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const finalLead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(finalOrder?.status, "REVERSED");
    assert.equal(finalLead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(finalLead?.customerPaidAt, null);
    assert.notEqual(finalLead?.paymentStatus, "CUSTOMER_PAID");
});

test("finalize after REVERSED does not mark CUSTOMER_PAID", async () => {
    const { shipment, payment } = await reverseCompletedPayment();
    installPayPalMock({
        orderStatus: "COMPLETED",
        captureStatus: "COMPLETED",
        captureId: "CAP-TEST",
    });
    await assert.rejects(
        () => payPalCheckoutService.captureAndMarkPaid(payment.paypalOrderId, billingActor),
        (err: { code?: string }) => err.code === "PAYPAL_CAPTURE_REVERSED"
    );
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
});

test("five or more sequential terminal attempts each get a new retry link", async () => {
    const { shipment, payment: first } = await reverseCompletedPayment();
    const historyIds = [first.paypalCustomerOrderId];
    const captureIds = ["CAP-TEST"];

    for (let i = 1; i <= 5; i += 1) {
        installPayPalMock({
            createOrderId: `ORDER-RETRY-${i}`,
            createApprovalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER-RETRY-${i}`,
        });
        const generated = await payPalCheckoutService.generatePaymentLink(
            billingActor,
            shipment.shipmentLeadId
        );
        assert.equal(generated.paypalOrderId, `ORDER-RETRY-${i}`);
        assert.ok(!historyIds.includes(generated.paypalCustomerOrderId));
        assert.equal(generated.captureId, null);
        assert.equal(generated.reversedAt, null);
        historyIds.push(generated.paypalCustomerOrderId);

        // Close this attempt as REVERSED so the next Generate advances the chain.
        await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: generated.paypalCustomerOrderId },
            data: {
                status: "REVERSED",
                captureId: `CAP-RETRY-${i}`,
                reversalId: `CAP-RETRY-${i}`,
                reversedAt: new Date(),
                needsAccountingReview: true,
                paidAt: null,
            },
        });
        captureIds.push(`CAP-RETRY-${i}`);
    }

    const rows = await prisma.payPalCustomerOrder.findMany({
        where: { shipmentLeadId: shipment.shipmentLeadId },
        orderBy: { createdAt: "asc" },
    });
    assert.ok(rows.length >= 6);
    const keys = new Set(rows.map((r) => r.idempotencyKey));
    assert.equal(keys.size, rows.length);
    const orderIds = new Set(rows.map((r) => r.paypalOrderId));
    assert.equal(orderIds.size, rows.length);
    for (const row of rows) {
        if (row.paypalCustomerOrderId === first.paypalCustomerOrderId) {
            assert.equal(row.captureId, "CAP-TEST");
            assert.equal(row.status, "REVERSED");
        }
    }
});

test("repeated Generate returns the same open attempt", async () => {
    const { shipment } = await reverseCompletedPayment();
    installPayPalMock({
        createOrderId: "ORDER-SAME",
        createApprovalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-SAME",
    });
    const a = await payPalCheckoutService.generatePaymentLink(billingActor, shipment.shipmentLeadId);
    const b = await payPalCheckoutService.generatePaymentLink(billingActor, shipment.shipmentLeadId);
    assert.equal(a.paypalCustomerOrderId, b.paypalCustomerOrderId);
    assert.equal(a.paypalOrderId, "ORDER-SAME");
    assert.equal(b.paypalOrderId, "ORDER-SAME");
});

test("two concurrent Generate requests converge on one active attempt", async () => {
    const { shipment } = await reverseCompletedPayment();
    installPayPalMock({
        createOrderId: "ORDER-CONCURRENT",
        createApprovalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-CONCURRENT",
    });
    const [a, b] = await Promise.all([
        payPalCheckoutService.generatePaymentLink(billingActor, shipment.shipmentLeadId),
        payPalCheckoutService.generatePaymentLink(billingActor, shipment.shipmentLeadId),
    ]);
    assert.equal(a.paypalOrderId, b.paypalOrderId);
    assert.equal(a.paypalCustomerOrderId, b.paypalCustomerOrderId);
    const open = await prisma.payPalCustomerOrder.count({
        where: {
            shipmentLeadId: shipment.shipmentLeadId,
            status: { in: ["CREATED", "APPROVED", "CAPTURE_PENDING"] },
        },
    });
    assert.equal(open, 1);
});

test("refreshStatus racing with REVERSED preserves terminal state", async () => {
    const { shipment, payment } = await createPayment({ status: "APPROVED", paid: false });
    installPayPalMock({ orderStatus: "APPROVED" });
    const refreshPromise = payPalCheckoutService.refreshStatus(
        billingActor,
        shipment.shipmentLeadId
    );
    const reversePromise = (async () => {
        await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: payment.paypalCustomerOrderId },
            data: {
                status: "REVERSED",
                reversedAt: new Date(),
                reversalId: "CAP-TEST",
                needsAccountingReview: true,
                paidAt: null,
            },
        });
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: shipment.shipmentLeadId },
            data: {
                customerPaidAt: null,
                paymentStatus: "CUSTOMER_REVERSED",
            },
        });
    })();
    await Promise.allSettled([refreshPromise, reversePromise]);
    const order = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalCustomerOrderId: payment.paypalCustomerOrderId },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(order?.status, "REVERSED");
    assert.ok(order?.reversedAt);
    assert.equal(order?.needsAccountingReview, true);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
});

test("refreshStatus racing with REFUNDED preserves terminal state", async () => {
    const { shipment, payment } = await createPayment({ status: "APPROVED", paid: false });
    installPayPalMock({ orderStatus: "APPROVED" });
    const refreshPromise = payPalCheckoutService.refreshStatus(
        billingActor,
        shipment.shipmentLeadId
    );
    const refundPromise = (async () => {
        await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: payment.paypalCustomerOrderId },
            data: {
                status: "REFUNDED",
                refundedAt: new Date(),
                refundId: "REFUND-RACE",
                paidAt: null,
            },
        });
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: shipment.shipmentLeadId },
            data: {
                customerPaidAt: null,
                paymentStatus: "CUSTOMER_REFUNDED",
            },
        });
    })();
    await Promise.allSettled([refreshPromise, refundPromise]);
    const order = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalCustomerOrderId: payment.paypalCustomerOrderId },
    });
    assert.equal(order?.status, "REFUNDED");
    assert.ok(order?.refundedAt);
    assert.equal(order?.refundId, "REFUND-RACE");
});

test("duplicate REFUNDED and REVERSED events stay idempotent", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-DUP-REFUND", {
        id: "REFUND-DUP",
        status: "COMPLETED",
    });
    const refundReplay = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-DUP-REFUND", {
        id: "REFUND-DUP",
        status: "COMPLETED",
    });
    assert.equal(refundReplay.duplicate, true);

    await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-DUP-REV", {
        id: "CAP-TEST",
        status: "REVERSED",
    });
    const revReplay = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-DUP-REV", {
        id: "CAP-TEST",
        status: "REVERSED",
    });
    assert.equal(revReplay.duplicate, true);

    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
});

async function assertTerminalReversedWithFacts(input: {
    shipmentLeadId: string;
    refundId: string;
    reversalId?: string;
}) {
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: input.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.ok(payment?.reversedAt);
    assert.equal(payment?.refundId, input.refundId);
    assert.ok(payment?.refundedAt);
    assert.equal(payment?.needsAccountingReview, true);
    assert.equal(payment?.paidAt, null);
    if (input.reversalId) {
        assert.equal(payment?.reversalId, input.reversalId);
    } else {
        assert.ok(payment?.reversalId);
    }
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
    assert.notEqual(lead?.paymentStatus, "CUSTOMER_PAID");
}

test("REVERSED commits before REFUNDED keeps REVERSED and records refund facts", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const reverse = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-THEN-REF", {
        id: "CAP-REV-FIRST",
        status: "REVERSED",
    });
    assert.equal(reverse.result, "reversed");
    const refund = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-REF-AFTER-REV-SEQ", {
        id: "REFUND-AFTER-REV-SEQ",
        status: "COMPLETED",
    });
    assert.equal(refund.result, "refund_recorded_on_reversed");
    await assertTerminalReversedWithFacts({
        shipmentLeadId: shipment.shipmentLeadId,
        refundId: "REFUND-AFTER-REV-SEQ",
        reversalId: "CAP-REV-FIRST",
    });
});

test("REFUNDED commits before REVERSED upgrades and preserves refund facts", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const refund = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-REF-THEN-REV", {
        id: "REFUND-BEFORE-REV",
        status: "COMPLETED",
    });
    assert.equal(refund.result, "refunded");
    const reverse = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-AFTER-REF-SEQ", {
        id: "CAP-REV-SECOND",
        status: "REVERSED",
    });
    assert.equal(reverse.result, "reversed");
    await assertTerminalReversedWithFacts({
        shipmentLeadId: shipment.shipmentLeadId,
        refundId: "REFUND-BEFORE-REV",
        reversalId: "CAP-REV-SECOND",
    });
});

test("concurrent REFUNDED and REVERSED converge on REVERSED with both financial facts", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const results = await Promise.allSettled([
        applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-RACE-REFUND", {
            id: "REFUND-RACE-CONCURRENT",
            status: "COMPLETED",
        }),
        applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-RACE-REVERSE", {
            id: "CAP-RACE-CONCURRENT",
            status: "REVERSED",
        }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    await assertTerminalReversedWithFacts({
        shipmentLeadId: shipment.shipmentLeadId,
        refundId: "REFUND-RACE-CONCURRENT",
        reversalId: "CAP-RACE-CONCURRENT",
    });
});

test("duplicate distinct REFUNDED events stay idempotent without leaving REVERSED", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const first = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-REF-A", {
        id: "REFUND-A",
        status: "COMPLETED",
    });
    assert.equal(first.result, "refunded");
    const second = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-REF-B", {
        id: "REFUND-B",
        status: "COMPLETED",
    });
    assert.equal(second.result, "already_refunded");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REFUNDED");
    assert.equal(payment?.refundId, "REFUND-A");
    assert.ok(payment?.refundedAt);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REFUNDED");
    assert.equal(lead?.customerPaidAt, null);
});

test("duplicate distinct REVERSED events stay idempotent and keep Accounting review", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const first = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-A", {
        id: "CAP-REV-A",
        status: "REVERSED",
    });
    assert.equal(first.result, "reversed");
    const second = await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-REV-B", {
        id: "CAP-REV-B",
        status: "REVERSED",
    });
    assert.equal(second.result, "already_reversed");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.equal(payment?.reversalId, "CAP-REV-A");
    assert.equal(payment?.needsAccountingReview, true);
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
});

test("stale non-COMPLETED capture cannot overwrite REVERSED", async () => {
    const { shipment } = await createPayment({ status: "CAPTURE_PENDING", paid: false });
    installPayPalMock({
        captureStatus: "DENIED",
        captureId: "CAP-STALE-DENIED",
        captureDelayMs: 40,
    });
    const [reverseResult] = await Promise.all([
        applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-STALE-DENIED-REV", {
            id: "CAP-STALE-DENIED",
            status: "REVERSED",
        }),
        payPalCheckoutService.captureAndMarkPaid("ORDER-TEST", billingActor).catch(() => null),
    ]);
    assert.ok(
        reverseResult.result === "reversed" || reverseResult.result === "already_reversed"
    );
    // Ensure reverse is present even if capture finished first.
    if (
        (
            await prisma.payPalCustomerOrder.findUnique({
                where: { paypalOrderId: "ORDER-TEST" },
            })
        )?.status !== "REVERSED"
    ) {
        await applyWebhook("PAYMENT.CAPTURE.REVERSED", "WH-STALE-DENIED-REV-LATE", {
            id: "CAP-STALE-DENIED",
            status: "REVERSED",
        });
    }
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REVERSED");
    assert.ok(payment?.reversedAt);
    assert.equal(payment?.needsAccountingReview, true);
    assert.notEqual(payment?.status, "DENIED");
    assert.equal(lead?.paymentStatus, "CUSTOMER_REVERSED");
    assert.equal(lead?.customerPaidAt, null);
    assert.notEqual(lead?.paymentStatus, "CUSTOMER_PAID");
});

test("stale non-COMPLETED capture cannot overwrite REFUNDED", async () => {
    const { shipment } = await createPayment({ status: "CAPTURE_PENDING", paid: false });
    installPayPalMock({
        captureStatus: "DENIED",
        captureId: "CAP-STALE-DENIED-REF",
        captureDelayMs: 40,
    });
    await Promise.all([
        applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-STALE-DENIED-REF", {
            id: "REFUND-STALE-DENIED",
            status: "COMPLETED",
        }),
        payPalCheckoutService.captureAndMarkPaid("ORDER-TEST", billingActor).catch(() => null),
    ]);
    if (
        (
            await prisma.payPalCustomerOrder.findUnique({
                where: { paypalOrderId: "ORDER-TEST" },
            })
        )?.status !== "REFUNDED"
    ) {
        await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-STALE-DENIED-REF-LATE", {
            id: "REFUND-STALE-DENIED",
            status: "COMPLETED",
        });
    }
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REFUNDED");
    assert.equal(payment?.refundId, "REFUND-STALE-DENIED");
    assert.ok(payment?.refundedAt);
    assert.notEqual(payment?.status, "DENIED");
    assert.equal(lead?.paymentStatus, "CUSTOMER_REFUNDED");
    assert.equal(lead?.customerPaidAt, null);
    assert.notEqual(lead?.paymentStatus, "CUSTOMER_PAID");
});

test("stale PROCESSING lease is reclaimed and business handler runs", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const staleStarted = new Date(Date.now() - 10 * 60_000);
    await prisma.payPalWebhookEvent.create({
        data: {
            eventId: "WH-STALE-LEASE-REFUND",
            eventType: "PAYMENT.CAPTURE.REFUNDED",
            environment: "sandbox",
            paypalOrderId: "ORDER-TEST",
            resourceId: "REFUND-STALE-LEASE",
            processed: false,
            processResult: "PROCESSING",
            processingStartedAt: staleStarted,
            rawPayloadJson: "{}",
        },
    });
    const result = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-STALE-LEASE-REFUND", {
        id: "REFUND-STALE-LEASE",
        status: "COMPLETED",
    });
    assert.equal(result.retryable, false);
    assert.equal(result.duplicate, false);
    assert.equal(result.result, "refunded");
    const event = await prisma.payPalWebhookEvent.findUnique({
        where: { eventId: "WH-STALE-LEASE-REFUND" },
    });
    assert.equal(event?.processed, true);
    assert.equal(event?.processResult, "refunded");
    assert.equal(event?.processingStartedAt, null);
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REFUNDED");
    assert.equal(payment?.refundId, "REFUND-STALE-LEASE");
    assert.equal(lead?.paymentStatus, "CUSTOMER_REFUNDED");
});

test("fresh PROCESSING lease asks for retry without re-executing", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    await prisma.payPalWebhookEvent.create({
        data: {
            eventId: "WH-FRESH-LEASE",
            eventType: "PAYMENT.CAPTURE.REFUNDED",
            environment: "sandbox",
            paypalOrderId: "ORDER-TEST",
            resourceId: "REFUND-FRESH",
            processed: false,
            processResult: "PROCESSING",
            processingStartedAt: new Date(),
            rawPayloadJson: "{}",
        },
    });
    const result = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-FRESH-LEASE", {
        id: "REFUND-FRESH",
        status: "COMPLETED",
    });
    assert.equal(result.retryable, true);
    assert.equal(result.result, "processing");
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "COMPLETED");
    assert.equal(payment?.refundId, null);
    assert.equal(lead?.paymentStatus, "CUSTOMER_PAID");
    const event = await prisma.payPalWebhookEvent.findUnique({
        where: { eventId: "WH-FRESH-LEASE" },
    });
    assert.equal(event?.processed, false);
    assert.equal(event?.processResult, "PROCESSING");
});

test("two workers racing the same webhook claim once", async () => {
    await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    const results = await Promise.all([
        applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-CLAIM-RACE", {
            id: "REFUND-CLAIM-RACE",
            status: "COMPLETED",
        }),
        applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-CLAIM-RACE", {
            id: "REFUND-CLAIM-RACE",
            status: "COMPLETED",
        }),
    ]);
    const finals = results.filter((r) => r.result === "refunded" && !r.retryable);
    const skipped = results.filter(
        (r) => r.retryable === true || r.duplicate === true || r.result === "already_refunded"
    );
    assert.equal(finals.length, 1);
    assert.equal(skipped.length, 1);
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    assert.equal(payment?.status, "REFUNDED");
    assert.equal(payment?.refundId, "REFUND-CLAIM-RACE");
});

test("handler failure leaves error lease and retry succeeds", async () => {
    const { shipment } = await createPayment({ status: "COMPLETED", paid: true });
    installPayPalMock({});
    await assert.rejects(
        () =>
            applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-ERR-THEN-OK", {
                id: "REFUND-ERR",
                status: "COMPLETED",
                amount: { value: "999.00", currency_code: "USD" },
            }),
        (err: { code?: string }) => err.code === "PAYPAL_REFUND_AMOUNT_INVALID"
    );
    const failed = await prisma.payPalWebhookEvent.findUnique({
        where: { eventId: "WH-ERR-THEN-OK" },
    });
    assert.equal(failed?.processed, false);
    assert.match(String(failed?.processResult || ""), /^error:/);

    const retry = await applyWebhook("PAYMENT.CAPTURE.REFUNDED", "WH-ERR-THEN-OK", {
        id: "REFUND-ERR-OK",
        status: "COMPLETED",
    });
    assert.equal(retry.result, "refunded");
    assert.equal(retry.retryable, false);
    const payment = await prisma.payPalCustomerOrder.findUnique({
        where: { paypalOrderId: "ORDER-TEST" },
    });
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(payment?.status, "REFUNDED");
    assert.equal(lead?.paymentStatus, "CUSTOMER_REFUNDED");
});

test("openExisting reuses matching env+amount and rejects mismatches", async () => {
    const { shipment, payment } = await createPayment({ status: "APPROVED", paid: false });
    installPayPalMock({
        createOrderId: "ORDER-SHOULD-NOT-CREATE",
        createApprovalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-SHOULD-NOT-CREATE",
    });
    const reused = await payPalCheckoutService.generatePaymentLink(
        billingActor,
        shipment.shipmentLeadId
    );
    assert.equal(reused.paypalCustomerOrderId, payment.paypalCustomerOrderId);
    assert.equal(reused.paypalOrderId, "ORDER-TEST");

    // Wrong environment must not be reused while Checkout is sandbox.
    await prisma.payPalCustomerOrder.update({
        where: { paypalCustomerOrderId: payment.paypalCustomerOrderId },
        data: { environment: "live", status: "APPROVED" },
    });
    installPayPalMock({
        createOrderId: "ORDER-SANDBOX-AFTER-LIVE",
        createApprovalUrl:
            "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-SANDBOX-AFTER-LIVE",
    });
    const afterEnv = await payPalCheckoutService.generatePaymentLink(
        billingActor,
        shipment.shipmentLeadId
    );
    assert.equal(afterEnv.paypalOrderId, "ORDER-SANDBOX-AFTER-LIVE");
    assert.equal(afterEnv.environment, "sandbox");
    assert.notEqual(afterEnv.paypalCustomerOrderId, payment.paypalCustomerOrderId);

    // Wrong amount must not be reused when the shipment quote changes.
    await prisma.shipmentLead.update({
        where: { shipmentLeadId: shipment.shipmentLeadId },
        data: { customerRate: 200 },
    });
    installPayPalMock({
        createOrderId: "ORDER-AFTER-AMOUNT",
        createApprovalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-AFTER-AMOUNT",
    });
    const afterAmount = await payPalCheckoutService.generatePaymentLink(
        billingActor,
        shipment.shipmentLeadId
    );
    assert.equal(afterAmount.paypalOrderId, "ORDER-AFTER-AMOUNT");
    assert.equal(afterAmount.amountUsd, 200);
    assert.notEqual(afterAmount.paypalCustomerOrderId, afterEnv.paypalCustomerOrderId);
});

test("retry chain exhaustion returns a clear safe error", async () => {
    const { createHash } = await import("node:crypto");
    const { paypalAttemptIdempotencyKey } = await import("./paypal-payment-safety.js");
    const { shipment, payment } = await createPayment({ status: "REVERSED", paid: false });
    const invoiceNumber = shipment.invoiceNumber || "";
    const baseKey = createHash("sha256")
        .update([shipment.shipmentLeadId, "10000", invoiceNumber, "sandbox"].join("|"))
        .digest("hex")
        .slice(0, 48);
    // Occupy attempt 0 with the deterministic base key used by Generate.
    await prisma.payPalCustomerOrder.update({
        where: { paypalCustomerOrderId: payment.paypalCustomerOrderId },
        data: {
            idempotencyKey: baseKey,
            status: "REVERSED",
            reversedAt: new Date(),
            reversalId: "CAP-BASE",
            needsAccountingReview: true,
            paidAt: null,
        },
    });
    // Fill remaining attempt slots 1..63.
    for (let i = 1; i < 64; i += 1) {
        await prisma.payPalCustomerOrder.create({
            data: {
                shipmentLeadId: shipment.shipmentLeadId,
                paypalOrderId: `ORDER-EXH-${i}`,
                environment: "sandbox",
                invoiceNumber,
                customerName: shipment.customerName,
                customerEmail: shipment.customerEmail,
                amountUsd: 100,
                currency: "USD",
                status: "REVERSED",
                approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER-EXH-${i}`,
                idempotencyKey: paypalAttemptIdempotencyKey(baseKey, i),
                captureId: `CAP-EXH-${i}`,
                reversalId: `CAP-EXH-${i}`,
                reversedAt: new Date(),
                needsAccountingReview: true,
                paidAt: null,
            },
        });
    }
    installPayPalMock({
        createOrderId: "ORDER-SHOULD-NOT",
        createApprovalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-SHOULD-NOT",
    });
    await assert.rejects(
        () => payPalCheckoutService.generatePaymentLink(billingActor, shipment.shipmentLeadId),
        (err: { code?: string }) => err.code === "PAYPAL_RETRY_CHAIN_EXHAUSTED"
    );
    const count = await prisma.payPalCustomerOrder.count({
        where: { shipmentLeadId: shipment.shipmentLeadId },
    });
    assert.equal(count, 64);
    assert.equal(
        await prisma.payPalCustomerOrder.count({
            where: { paypalOrderId: "ORDER-SHOULD-NOT" },
        }),
        0
    );
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

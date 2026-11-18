import assert from "node:assert/strict";
import test from "node:test";
import {
    buildPaidPaymentTxns,
    buildReceivedPaymentTxns,
    dashboardPaymentRange,
    invoiceReceivedAmountUsd,
    isPaidAtInRange,
    sumTxnsInRange,
} from "./dashboard-payment-kpis.js";

const range = dashboardPaymentRange(new Date("2026-11-18T12:00:00.000Z"), 30);

test("date range is last N days ending at now", () => {
    assert.equal(range.label, "Last 30 Days");
    assert.equal(range.to.toISOString(), "2026-11-18T12:00:00.000Z");
    assert.equal(range.from.toISOString(), "2026-10-19T12:00:00.000Z");
});

test("RECEIVED includes completed PayPal order amounts by paidAt", () => {
    const txns = buildReceivedPaymentTxns({
        paypalOrders: [
            {
                paypalCustomerOrderId: "o1",
                shipmentLeadId: "s1",
                status: "COMPLETED",
                amountUsd: 1000,
                paidAt: "2026-11-01T00:00:00.000Z",
            },
            {
                paypalCustomerOrderId: "o-pending",
                shipmentLeadId: "s2",
                status: "APPROVED",
                amountUsd: 500,
                paidAt: "2026-11-01T00:00:00.000Z",
            },
            {
                paypalCustomerOrderId: "o-refunded",
                shipmentLeadId: "s3",
                status: "REFUNDED",
                amountUsd: 700,
                paidAt: "2026-11-01T00:00:00.000Z",
            },
            {
                paypalCustomerOrderId: "o-old",
                shipmentLeadId: "s4",
                status: "COMPLETED",
                amountUsd: 200,
                paidAt: "2026-09-01T00:00:00.000Z",
            },
        ],
        paypalInvoices: [],
        manualShipments: [],
    });
    assert.equal(sumTxnsInRange(txns, range), 1000);
});

test("RECEIVED uses invoice paid_amount for partials and excludes unpaid", () => {
    const partial = invoiceReceivedAmountUsd({
        status: "PARTIALLY_PAID",
        totalUsd: 1000,
        rawLatestJson: JSON.stringify({
            payments: { paid_amount: { value: "250.00" } },
        }),
    });
    assert.equal(partial, 250);

    assert.equal(
        invoiceReceivedAmountUsd({ status: "SENT", totalUsd: 1000 }),
        null
    );
    assert.equal(
        invoiceReceivedAmountUsd({ status: "REFUNDED", totalUsd: 1000 }),
        null
    );

    const txns = buildReceivedPaymentTxns({
        paypalOrders: [],
        paypalInvoices: [
            {
                paypalCustomerInvoiceId: "i1",
                shipmentLeadId: "s1",
                status: "PARTIALLY_PAID",
                totalUsd: 1000,
                paidAt: "2026-11-05T00:00:00.000Z",
                rawLatestJson: JSON.stringify({
                    payments: { paid_amount: { value: "250.00" } },
                }),
            },
            {
                paypalCustomerInvoiceId: "i2",
                shipmentLeadId: "s2",
                status: "PAID",
                totalUsd: 800,
                paidAt: "2026-11-06T00:00:00.000Z",
            },
        ],
        manualShipments: [],
    });
    assert.equal(sumTxnsInRange(txns, range), 1050);
});

test("RECEIVED does not double-count PayPal + manual on same shipment", () => {
    const txns = buildReceivedPaymentTxns({
        paypalOrders: [
            {
                paypalCustomerOrderId: "o1",
                shipmentLeadId: "s1",
                status: "COMPLETED",
                amountUsd: 1030,
                paidAt: "2026-11-02T00:00:00.000Z",
            },
        ],
        paypalInvoices: [],
        manualShipments: [
            {
                shipmentLeadId: "s1",
                customerPaidAt: "2026-11-02T00:00:00.000Z",
                amountUsd: 1030,
            },
            {
                shipmentLeadId: "s2",
                customerPaidAt: "2026-11-03T00:00:00.000Z",
                amountUsd: 500,
            },
        ],
    });
    assert.equal(sumTxnsInRange(txns, range), 1530);
});

test("PAID sums current carrier paid + each previous-carrier settlement once", () => {
    const txns = buildPaidPaymentTxns({
        carrierPaidLoads: [
            {
                shipmentLeadId: "s1",
                carrierPaidAt: "2026-11-10T00:00:00.000Z",
                amountUsd: 2000,
            },
        ],
        previousSettlements: [
            {
                settlementId: "p1",
                shipmentLeadId: "s1",
                status: "PAID",
                paymentAmount: 550,
                paidAt: "2026-11-08T00:00:00.000Z",
            },
            {
                settlementId: "p2",
                shipmentLeadId: "s1",
                status: "PENDING_ACCOUNTING",
                paymentAmount: 400,
                paidAt: null,
            },
            {
                settlementId: "p3",
                shipmentLeadId: "s1",
                status: "PAID",
                paymentAmount: 100,
                paidAt: "2026-09-01T00:00:00.000Z",
            },
        ],
    });
    assert.equal(sumTxnsInRange(txns, range), 2550);
});

test("pending carrier payments are excluded from PAID", () => {
    const txns = buildPaidPaymentTxns({
        carrierPaidLoads: [],
        previousSettlements: [
            {
                settlementId: "p1",
                shipmentLeadId: "s1",
                status: "APPROVED",
                paymentAmount: 900,
                paidAt: null,
            },
            {
                settlementId: "p2",
                shipmentLeadId: "s1",
                status: "INVOICE_UPLOADED",
                paymentAmount: 900,
                paidAt: null,
            },
        ],
    });
    assert.equal(sumTxnsInRange(txns, range), 0);
});

test("isPaidAtInRange uses payment date not shipment creation", () => {
    assert.equal(isPaidAtInRange("2026-11-01T00:00:00.000Z", range), true);
    assert.equal(isPaidAtInRange("2026-09-01T00:00:00.000Z", range), false);
    assert.equal(isPaidAtInRange(null, range), false);
});

test("duplicate txn ids are counted once", () => {
    const paidAt = new Date("2026-11-01T00:00:00.000Z");
    const sum = sumTxnsInRange(
        [
            { id: "x", amountUsd: 100, paidAt },
            { id: "x", amountUsd: 100, paidAt },
            { id: "y", amountUsd: 50, paidAt },
        ],
        range
    );
    assert.equal(sum, 150);
});

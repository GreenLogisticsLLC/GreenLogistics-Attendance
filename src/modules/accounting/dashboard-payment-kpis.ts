/**
 * Accounting Dashboard RECEIVED / PAID KPI aggregates.
 *
 * Source of truth = actual payment transaction records where they exist
 * (PayPal Checkout orders, PayPal Invoices, previous-carrier settlements),
 * plus shipment-level customerPaidAt / carrierPaidAt for offline / manual marks.
 * Does not invent a second ledger.
 */
import { prisma } from "../../config/database.js";
import { customerPaymentQuote } from "../shipment/customer-payment.js";
import { effectiveCarrierPaidReportingDate } from "../shipment/carrier-payment-method.js";
import {
    loadInvoicePricingSettings,
    type InvoicePricingSettings,
} from "./invoice-pricing.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DASHBOARD_PAYMENT_RANGE_DAYS = 30;

export type PaymentKpiRange = {
    from: Date;
    to: Date;
    days: number;
    label: string;
};

export type ReceivedPaymentTxn = {
    id: string;
    shipmentLeadId: string;
    amountUsd: number;
    paidAt: Date;
    source: "paypal_order" | "paypal_invoice" | "manual";
};

export type PaidPaymentTxn = {
    id: string;
    shipmentLeadId: string;
    amountUsd: number;
    paidAt: Date;
    source: "carrier_load" | "previous_carrier_settlement";
};

const RECEIVED_ORDER_STATUSES = new Set(["COMPLETED"]);
const RECEIVED_INVOICE_STATUSES = new Set([
    "PAID",
    "MARKED_AS_PAID",
    "PARTIALLY_PAID",
]);
const EXCLUDED_MONEY_STATUSES = new Set([
    "CREATED",
    "APPROVED",
    "CAPTURE_PENDING",
    "DENIED",
    "FAILED",
    "CANCELLED",
    "REFUNDED",
    "REVERSED",
    "DRAFT",
    "SENT",
    "SCHEDULED",
    "UNPAID",
    "PAYMENT_PENDING",
    "PARTIALLY_REFUNDED",
    "MARKED_AS_REFUNDED",
]);

function money(n: unknown): number {
    const v = Number(n);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function asDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
}

export function dashboardPaymentRange(
    now: Date = new Date(),
    days = DASHBOARD_PAYMENT_RANGE_DAYS
): PaymentKpiRange {
    const to = new Date(now);
    const from = new Date(to.getTime() - days * DAY_MS);
    return {
        from,
        to,
        days,
        label: days === 30 ? "Last 30 Days" : `Last ${days} Days`,
    };
}

export function isPaidAtInRange(
    paidAt: Date | string | null | undefined,
    range: Pick<PaymentKpiRange, "from" | "to">
): boolean {
    const d = asDate(paidAt);
    if (!d) return false;
    const t = d.getTime();
    return t >= range.from.getTime() && t < range.to.getTime();
}

/** Prefer PayPal payments.paid_amount when present; else invoice total for fully paid. */
export function invoiceReceivedAmountUsd(inv: {
    status?: string | null;
    totalUsd?: number | null;
    rawLatestJson?: string | null;
}): number | null {
    const status = String(inv.status || "").toUpperCase();
    if (!RECEIVED_INVOICE_STATUSES.has(status) || EXCLUDED_MONEY_STATUSES.has(status)) {
        return null;
    }
    let paidFromRaw: number | null = null;
    if (inv.rawLatestJson) {
        try {
            const raw = JSON.parse(inv.rawLatestJson) as {
                payments?: { paid_amount?: { value?: string | number } };
            };
            const rawPaid = raw?.payments?.paid_amount?.value;
            if (rawPaid != null && rawPaid !== "") {
                const n = Number(rawPaid);
                if (Number.isFinite(n) && n > 0) paidFromRaw = money(n);
            }
        } catch {
            /* ignore bad snapshot */
        }
    }
    if (paidFromRaw != null) return paidFromRaw;
    if (status === "PARTIALLY_PAID") return null;
    const total = money(inv.totalUsd);
    return total > 0 ? total : null;
}

export function buildReceivedPaymentTxns(input: {
    paypalOrders: Array<{
        paypalCustomerOrderId: string;
        shipmentLeadId: string;
        status: string;
        amountUsd: number;
        paidAt?: Date | string | null;
        captureCompletedAt?: Date | string | null;
    }>;
    paypalInvoices: Array<{
        paypalCustomerInvoiceId: string;
        shipmentLeadId: string;
        status: string;
        totalUsd: number;
        paidAt?: Date | string | null;
        rawLatestJson?: string | null;
    }>;
    manualShipments: Array<{
        shipmentLeadId: string;
        customerPaidAt: Date | string;
        amountUsd: number;
    }>;
}): ReceivedPaymentTxn[] {
    const txns: ReceivedPaymentTxn[] = [];
    const coveredByPayPal = new Set<string>();

    for (const o of input.paypalOrders) {
        const status = String(o.status || "").toUpperCase();
        if (!RECEIVED_ORDER_STATUSES.has(status)) continue;
        if (EXCLUDED_MONEY_STATUSES.has(status)) continue;
        const paidAt = asDate(o.paidAt) || asDate(o.captureCompletedAt);
        const amount = money(o.amountUsd);
        if (!paidAt || amount <= 0) continue;
        txns.push({
            id: `paypal_order:${o.paypalCustomerOrderId}`,
            shipmentLeadId: o.shipmentLeadId,
            amountUsd: amount,
            paidAt,
            source: "paypal_order",
        });
        coveredByPayPal.add(o.shipmentLeadId);
    }

    for (const inv of input.paypalInvoices) {
        const amount = invoiceReceivedAmountUsd(inv);
        const paidAt = asDate(inv.paidAt);
        if (amount == null || amount <= 0 || !paidAt) continue;
        txns.push({
            id: `paypal_invoice:${inv.paypalCustomerInvoiceId}`,
            shipmentLeadId: inv.shipmentLeadId,
            amountUsd: amount,
            paidAt,
            source: "paypal_invoice",
        });
        coveredByPayPal.add(inv.shipmentLeadId);
    }

    for (const s of input.manualShipments) {
        if (coveredByPayPal.has(s.shipmentLeadId)) continue;
        const paidAt = asDate(s.customerPaidAt);
        const amount = money(s.amountUsd);
        if (!paidAt || amount <= 0) continue;
        txns.push({
            id: `manual_customer:${s.shipmentLeadId}`,
            shipmentLeadId: s.shipmentLeadId,
            amountUsd: amount,
            paidAt,
            source: "manual",
        });
    }

    return txns;
}

export function buildPaidPaymentTxns(input: {
    carrierPaidLoads: Array<{
        shipmentLeadId: string;
        carrierPaidAt: Date | string;
        amountUsd: number;
    }>;
    previousSettlements: Array<{
        settlementId: string;
        shipmentLeadId: string;
        status: string;
        paymentAmount: number;
        paidAt?: Date | string | null;
    }>;
}): PaidPaymentTxn[] {
    const txns: PaidPaymentTxn[] = [];

    for (const s of input.carrierPaidLoads) {
        const paidAt = asDate(s.carrierPaidAt);
        const amount = money(s.amountUsd);
        if (!paidAt || amount <= 0) continue;
        txns.push({
            id: `carrier_load:${s.shipmentLeadId}`,
            shipmentLeadId: s.shipmentLeadId,
            amountUsd: amount,
            paidAt,
            source: "carrier_load",
        });
    }

    for (const row of input.previousSettlements) {
        const status = String(row.status || "").toUpperCase();
        if (status !== "PAID") continue;
        const paidAt = asDate(row.paidAt);
        const amount = money(row.paymentAmount);
        if (!paidAt || amount <= 0) continue;
        txns.push({
            id: `prev_carrier:${row.settlementId}`,
            shipmentLeadId: row.shipmentLeadId,
            amountUsd: amount,
            paidAt,
            source: "previous_carrier_settlement",
        });
    }

    return txns;
}

export function sumTxnsInRange(
    txns: Array<{ id: string; amountUsd: number; paidAt: Date }>,
    range: Pick<PaymentKpiRange, "from" | "to">
): number {
    const seen = new Set<string>();
    let sum = 0;
    for (const t of txns) {
        if (seen.has(t.id)) continue;
        if (!isPaidAtInRange(t.paidAt, range)) continue;
        seen.add(t.id);
        sum += money(t.amountUsd);
    }
    return money(sum);
}

function manualCustomerAmount(
    s: {
        customerRate?: number | null;
        accessorialCharges?: number | null;
        customerPaymentMethod?: string | null;
        waiveCustomerPaymentFee?: boolean | null;
        invoicePricingSnapshotJson?: string | null;
        invoiceTotalUsd?: number | null;
        price?: number | null;
    },
    pricing: InvoicePricingSettings
): number {
    const quote = customerPaymentQuote({
        customerRate: s.customerRate,
        accessorialCharges: s.accessorialCharges,
        method: s.customerPaymentMethod,
        waiveFee: s.waiveCustomerPaymentFee,
        pricing,
        pricingSnapshot: s.invoicePricingSnapshotJson,
    });
    return (
        money(quote.total) ||
        money(s.invoiceTotalUsd) ||
        money(quote.subtotal) ||
        money(quote.rate) ||
        money(s.price) ||
        0
    );
}

/**
 * Load RECEIVED + PAID totals for the dashboard date window.
 * A/R and A/P are intentionally left alone by callers.
 */
export async function computeDashboardPaymentKpis(input?: {
    now?: Date;
    days?: number;
    pricing?: InvoicePricingSettings;
}): Promise<{
    range: PaymentKpiRange;
    received: number;
    paid: number;
    receivedTxnCount: number;
    paidTxnCount: number;
}> {
    const range = dashboardPaymentRange(input?.now, input?.days);
    const pricing = input?.pricing || (await loadInvoicePricingSettings());

    const [paypalOrders, paypalInvoices, manualLeads, carrierPaidLeads, prevSettlements] =
        await Promise.all([
            prisma.payPalCustomerOrder.findMany({
                where: {
                    status: "COMPLETED",
                    OR: [
                        { paidAt: { gte: range.from, lt: range.to } },
                        {
                            paidAt: null,
                            captureCompletedAt: { gte: range.from, lt: range.to },
                        },
                    ],
                },
                select: {
                    paypalCustomerOrderId: true,
                    shipmentLeadId: true,
                    status: true,
                    amountUsd: true,
                    paidAt: true,
                    captureCompletedAt: true,
                },
            }),
            prisma.payPalCustomerInvoice.findMany({
                where: {
                    status: { in: ["PAID", "MARKED_AS_PAID", "PARTIALLY_PAID"] },
                    paidAt: { gte: range.from, lt: range.to },
                },
                select: {
                    paypalCustomerInvoiceId: true,
                    shipmentLeadId: true,
                    status: true,
                    totalUsd: true,
                    paidAt: true,
                    rawLatestJson: true,
                },
            }),
            prisma.shipmentLead.findMany({
                where: {
                    customerPaidAt: { gte: range.from, lt: range.to },
                    loadNumber: { not: null },
                },
                select: {
                    shipmentLeadId: true,
                    customerPaidAt: true,
                    customerRate: true,
                    accessorialCharges: true,
                    customerPaymentMethod: true,
                    waiveCustomerPaymentFee: true,
                    invoicePricingSnapshotJson: true,
                    invoiceTotalUsd: true,
                    price: true,
                },
            }),
            prisma.shipmentLead.findMany({
                where: {
                    carrierPaidAt: { not: null },
                    loadNumber: { not: null },
                    OR: [
                        {
                            accountingCarrierPaymentDate: {
                                gte: range.from,
                                lt: range.to,
                            },
                        },
                        {
                            accountingCarrierPaymentDate: null,
                            carrierPaidAt: { gte: range.from, lt: range.to },
                        },
                    ],
                },
                select: {
                    shipmentLeadId: true,
                    carrierPaidAt: true,
                    accountingCarrierPaymentDate: true,
                    carrierRate: true,
                },
            }),
            prisma.previousCarrierSettlement.findMany({
                where: {
                    status: "PAID",
                    paidAt: { gte: range.from, lt: range.to },
                },
                select: {
                    settlementId: true,
                    shipmentLeadId: true,
                    status: true,
                    paymentAmount: true,
                    paidAt: true,
                },
            }),
        ]);

    // Shipments already covered by a successful PayPal txn (any time) must not
    // also add a manual customerPaidAt amount for the same money movement.
    const paypalCoveredIds = new Set<string>([
        ...paypalOrders.map((o) => o.shipmentLeadId),
        ...paypalInvoices.map((i) => i.shipmentLeadId),
    ]);
    const uncoveredManualIds = [
        ...new Set(
            manualLeads
                .map((s) => s.shipmentLeadId)
                .filter((id) => !paypalCoveredIds.has(id))
        ),
    ];
    if (uncoveredManualIds.length) {
        // Exclude manuals when an older PayPal completion exists outside the window
        // but still owns the shipment payment (customerPaidAt was set by PayPal).
        const [extraCovered, extraInv] = await Promise.all([
            prisma.payPalCustomerOrder.findMany({
                where: {
                    shipmentLeadId: { in: uncoveredManualIds },
                    status: "COMPLETED",
                },
                select: { shipmentLeadId: true },
            }),
            prisma.payPalCustomerInvoice.findMany({
                where: {
                    shipmentLeadId: { in: uncoveredManualIds },
                    status: { in: ["PAID", "MARKED_AS_PAID"] },
                },
                select: { shipmentLeadId: true },
            }),
        ]);
        for (const row of extraCovered) paypalCoveredIds.add(row.shipmentLeadId);
        for (const row of extraInv) paypalCoveredIds.add(row.shipmentLeadId);
    }

    const receivedTxns = buildReceivedPaymentTxns({
        paypalOrders,
        paypalInvoices,
        manualShipments: manualLeads
            .filter((s) => s.customerPaidAt && !paypalCoveredIds.has(s.shipmentLeadId))
            .map((s) => ({
                shipmentLeadId: s.shipmentLeadId,
                customerPaidAt: s.customerPaidAt as Date,
                amountUsd: manualCustomerAmount(s, pricing),
            })),
    });

    const paidTxns = buildPaidPaymentTxns({
        carrierPaidLoads: carrierPaidLeads
            .map((s) => {
                const paidAt = effectiveCarrierPaidReportingDate({
                    carrierPaidAt: s.carrierPaidAt,
                    accountingCarrierPaymentDate: s.accountingCarrierPaymentDate,
                });
                if (!paidAt) return null;
                return {
                    shipmentLeadId: s.shipmentLeadId,
                    carrierPaidAt: paidAt,
                    amountUsd: money(s.carrierRate),
                };
            })
            .filter((row): row is NonNullable<typeof row> => Boolean(row)),
        previousSettlements: prevSettlements,
    });

    const receivedInRange = receivedTxns.filter((t) => isPaidAtInRange(t.paidAt, range));
    const paidInRange = paidTxns.filter((t) => isPaidAtInRange(t.paidAt, range));

    return {
        range,
        received: sumTxnsInRange(receivedTxns, range),
        paid: sumTxnsInRange(paidTxns, range),
        receivedTxnCount: receivedInRange.length,
        paidTxnCount: paidInRange.length,
    };
}

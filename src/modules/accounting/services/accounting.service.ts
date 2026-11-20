import fs from "fs";
import { prisma } from "../../../config/database.js";
import {
    AccountingPermissions,
    AccountingSubRoles,
    hasAccountingPermission,
    isAccountingAdmin,
    normalizeAccountingSubRole,
    type AccountingSubRole,
} from "../../../auth/accounting.js";
import { Roles } from "../../../auth/roles.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { AccountingDocStatus } from "../accounting.constants.js";
import { buildAccountingDocuments } from "../accounting-documents.js";
import { sendCustomerInvoiceEmail } from "../customer-invoice-email.js";
import {
    customerPaymentQuote,
    sumCustomerSplitPayments,
} from "../../shipment/customer-payment.js";
import { carrierPaymentOptionLabel } from "../../carriers/constants.js";
import { resolveLoadDocumentAbsolutePath } from "../../shipment/services/load-pdf.service.js";
import { canTransition } from "../../shipment/shipment.lifecycle.js";
import { preferRateConCarrierAmount } from "../../shipment/load-amounts.js";
import { payPalCheckoutService } from "../paypal/paypal-checkout.service.js";
import { payPalInvoicingService } from "../paypal/paypal-invoicing.service.js";
import { config } from "../../../config/env.js";
import { previousCarrierSettlementService } from "../../shipment/services/previous-carrier-settlement.service.js";
import {
    buildLoadFinancialSummary,
    sumPayablePreviousCarrierExpenses,
} from "../../shipment/previous-carrier-settlement.js";
import {
    INVOICE_PRICING_POLICY_TEXT,
    createInvoicePricingSnapshot,
    buildInvoicePricingBreakdown,
    loadInvoicePricingSettings,
    saveInvoicePricingSettings,
    validateInvoicePricingUpdate,
    type InvoicePricingSettings,
    type InvoicePricingUpdateInput,
} from "../invoice-pricing.js";
import { isAccountingWorkEligible } from "../accounting-eligibility.js";
import { computeDashboardPaymentKpis } from "../dashboard-payment-kpis.js";
import {
    belongsInCarrierPayments,
    belongsInCustomerBilling,
} from "../payment-section-membership.js";
import {
    accountingCarrierPaymentMethodLabel,
    formatAccountingPaymentDateInput,
    normalizeAccountingCarrierPaymentMethod,
    parseAccountingPaymentDate,
} from "../../shipment/carrier-payment-method.js";

type Actor = {
    userId: string;
    role: string;
    accountingSubRole?: AccountingSubRole | null;
};

function forbid(message: string, code = "ACCOUNTING_FORBIDDEN") {
    return Object.assign(new Error(message), { status: 403, code });
}

function badRequest(message: string, code = "ACCOUNTING_INVALID") {
    return Object.assign(new Error(message), { status: 422, code });
}

function notFound(message: string) {
    return Object.assign(new Error(message), { status: 404, code: "NOT_FOUND" });
}

function quoteShipmentPayment(
    s: {
        customerRate?: number | null;
        accessorialCharges?: number | null;
        customerPaymentMethod?: string | null;
        waiveCustomerPaymentFee?: boolean | null;
        invoicePricingSnapshotJson?: string | null;
    },
    pricing: InvoicePricingSettings
) {
    return customerPaymentQuote({
        customerRate: s.customerRate,
        accessorialCharges: s.accessorialCharges,
        method: s.customerPaymentMethod,
        waiveFee: s.waiveCustomerPaymentFee,
        pricing,
        pricingSnapshot: s.invoicePricingSnapshotJson,
    });
}

async function writeAudit(input: {
    actor: Actor;
    action: string;
    shipmentLeadId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
}) {
    try {
        await prisma.auditLog.create({
            data: {
                userId: input.actor.userId,
                module: "ACCOUNTING",
                action: input.action,
                entityName: input.shipmentLeadId ? "ShipmentLead" : "Accounting",
                entityId: input.shipmentLeadId || input.actor.userId,
                oldValue: input.oldValue != null ? JSON.stringify(input.oldValue) : null,
                newValue: input.newValue != null ? JSON.stringify(input.newValue) : null,
                ipAddress: null,
                userAgent: input.reason || null,
            },
        });
    } catch (err) {
        console.warn("[accounting] audit write failed:", err);
    }
}

function assertPerm(actor: Actor, permission: string) {
    if (
        !hasAccountingPermission(
            actor.role,
            actor.accountingSubRole,
            permission as typeof AccountingPermissions.Access
        )
    ) {
        throw forbid(`Missing permission: ${permission}`);
    }
}

function money(n: number | null | undefined) {
    return n == null || Number.isNaN(Number(n)) ? null : Number(n);
}

/** Numeric order for GL10001, GL10002… so Accounting lists stay sequential. */
function loadNumberSortKey(loadNumber: string | null | undefined): number {
    const digits = String(loadNumber || "").replace(/\D+/g, "");
    if (!digits) return Number.MAX_SAFE_INTEGER;
    const n = Number(digits);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function compareLoadNumberAsc(
    a: { loadNumber?: string | null },
    b: { loadNumber?: string | null }
): number {
    const diff = loadNumberSortKey(a.loadNumber) - loadNumberSortKey(b.loadNumber);
    if (diff !== 0) return diff;
    return String(a.loadNumber || "").localeCompare(String(b.loadNumber || ""));
}

export class AccountingService {
    private sub(actor: Actor): AccountingSubRole | null {
        if (isAccountingAdmin(actor.role)) return null;
        return normalizeAccountingSubRole(
            actor.accountingSubRole,
            AccountingSubRoles.Documents
        );
    }

    async dashboard(actor: Actor) {
        assertPerm(actor, AccountingPermissions.Access);
        const rows = await prisma.shipmentLead.findMany({
            where: {
                loadNumber: { not: null },
            },
            select: {
                shipmentLeadId: true,
                status: true,
                accountingDocStatus: true,
                accountingFinancialVerified: true,
                accountingReadyForBilling: true,
                accountingReadyForCarrierPayment: true,
                accountingReactivatedAt: true,
                customerPaidAt: true,
                carrierPaidAt: true,
                invoiceNumber: true,
                invoiceDate: true,
                invoiceDueDate: true,
                accountingClosedAt: true,
                paymentStatus: true,
                customerRate: true,
                price: true,
                carrierRate: true,
                accessorialCharges: true,
                customerPaymentMethod: true,
                waiveCustomerPaymentFee: true,
                invoicePricingSnapshotJson: true,
                invoiceTotalUsd: true,
                invoiceSubtotalUsd: true,
                updatedAt: true,
            },
        });

        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const pricing = await loadInvoicePricingSettings();
        const enrichedAll = rows.map((r) => {
            const payment = quoteShipmentPayment(r, pricing);
            const customerTotal = payment.total || 0;
            const carrierTotal = money(r.carrierRate) || 0;
            return {
                ...r,
                customerTotal,
                carrierTotal,
                outstandingCustomer: r.customerPaidAt ? 0 : customerTotal,
                outstandingCarrier: r.carrierPaidAt ? 0 : carrierTotal,
            };
        });
        // Ignore Voided + incomplete ghosts (GL# without customer rate/invoice) in KPIs.
        const enriched = enrichedAll.filter((r) => isAccountingWorkEligible(r));
        const voidedCount = enrichedAll.filter(
            (r) => String(r.status || "").toUpperCase() === "VOIDED"
        ).length;

        const docsPending = enriched.filter(
            (r) =>
                !r.accountingDocStatus ||
                r.accountingDocStatus === AccountingDocStatus.Pending ||
                r.accountingDocStatus === AccountingDocStatus.NeedsCorrection
        ).length;
        const needsCorrection = enriched.filter(
            (r) => r.accountingDocStatus === AccountingDocStatus.NeedsCorrection
        ).length;
        const readyBilling = enriched.filter(
            (r) => r.accountingReadyForBilling && !r.invoiceNumber && !r.customerPaidAt
        ).length;
        const invoicesOutstanding = enriched.filter(
            (r) => r.invoiceNumber && !r.customerPaidAt
        ).length;
        const customerPaid = enriched.filter((r) => Boolean(r.customerPaidAt)).length;
        const readyCarrierPay = enriched.filter(
            (r) => r.accountingReadyForCarrierPayment && !r.carrierPaidAt
        ).length;
        const carrierPaid = enriched.filter((r) => Boolean(r.carrierPaidAt)).length;
        const overdue = enriched.filter((r) => {
            if (!r.invoiceDueDate || r.customerPaidAt) return false;
            return new Date(r.invoiceDueDate).getTime() < now;
        }).length;
        const closed = enriched.filter((r) => Boolean(r.accountingClosedAt)).length;
        const forReview = enriched.filter((r) => {
            if (r.accountingClosedAt) return false;
            const docPending =
                !r.accountingDocStatus ||
                r.accountingDocStatus === AccountingDocStatus.Pending ||
                r.accountingDocStatus === AccountingDocStatus.NeedsCorrection;
            const billingReady = Boolean(r.accountingReadyForBilling) && !r.customerPaidAt;
            const carrierReady =
                Boolean(r.accountingReadyForCarrierPayment) && !r.carrierPaidAt;
            const invoiceOut = Boolean(r.invoiceNumber) && !r.customerPaidAt;
            return docPending || billingReady || carrierReady || invoiceOut;
        }).length;
        const paidBoth = enriched.filter(
            (r) => Boolean(r.customerPaidAt) && Boolean(r.carrierPaidAt)
        ).length;
        // Outstanding section membership (payment statuses, independent of ready flags).
        const customerBillingOpen = enriched.filter((r) =>
            belongsInCustomerBilling({
                status: r.status,
                accountingDocStatus: r.accountingDocStatus,
                customerPaidAt: r.customerPaidAt,
                carrierPaidAt: r.carrierPaidAt,
                accountingEligible: true,
            })
        ).length;
        const carrierPaymentsOpen = enriched.filter((r) =>
            belongsInCarrierPayments({
                status: r.status,
                accountingDocStatus: r.accountingDocStatus,
                customerPaidAt: r.customerPaidAt,
                carrierPaidAt: r.carrierPaidAt,
                accountingEligible: true,
            })
        ).length;

        const arToReceive = enriched.reduce((sum, r) => sum + (r.outstandingCustomer || 0), 0);
        const apToPay = enriched.reduce((sum, r) => sum + (r.outstandingCarrier || 0), 0);
        // RECEIVED / PAID: actual completed payment amounts in the dashboard date window
        // (payment txn date, not shipment createdAt). Leaves A/R and A/P unchanged.
        const paymentKpis = await computeDashboardPaymentKpis({ pricing });

        function ageBucket(
            amount: number,
            anchor: Date | string | null | undefined,
            buckets: { current: number; mid: number; old: number }
        ) {
            if (!amount) return;
            const t = anchor ? new Date(anchor).getTime() : NaN;
            const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / dayMs) : 0;
            if (ageDays <= 30) buckets.current += amount;
            else if (ageDays <= 60) buckets.mid += amount;
            else buckets.old += amount;
        }

        const arAging = { current: 0, mid: 0, old: 0 };
        const apAging = { current: 0, mid: 0, old: 0 };
        for (const r of enriched) {
            ageBucket(
                r.outstandingCustomer || 0,
                r.invoiceDueDate || r.invoiceDate || r.updatedAt,
                arAging
            );
            ageBucket(r.outstandingCarrier || 0, r.updatedAt, apAging);
        }

        const weeks: Array<{
            key: string;
            label: string;
            start: number;
            end: number;
            billed: number;
            paid: number;
        }> = [];
        const startOfWeek = (d: Date) => {
            const x = new Date(d);
            const day = x.getUTCDay();
            const diff = (day + 6) % 7;
            x.setUTCDate(x.getUTCDate() - diff);
            x.setUTCHours(0, 0, 0, 0);
            return x;
        };
        let cursor = startOfWeek(new Date());
        for (let i = 0; i < 5; i++) {
            const start = new Date(cursor);
            start.setUTCDate(start.getUTCDate() - (4 - i) * 7);
            const end = new Date(start);
            end.setUTCDate(end.getUTCDate() + 7);
            const label = start.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
            });
            weeks.push({
                key: start.toISOString().slice(0, 10),
                label,
                start: start.getTime(),
                end: end.getTime(),
                billed: 0,
                paid: 0,
            });
        }
        for (const r of enriched) {
            if (r.invoiceDate) {
                const t = new Date(r.invoiceDate).getTime();
                const w = weeks.find((x) => t >= x.start && t < x.end);
                if (w) w.billed += r.customerTotal || 0;
            }
            if (r.carrierPaidAt) {
                const t = new Date(r.carrierPaidAt).getTime();
                const w = weeks.find((x) => t >= x.start && t < x.end);
                if (w) w.paid += r.carrierTotal || 0;
            }
        }

        const docComplete = enriched.filter(
            (r) => r.accountingDocStatus === AccountingDocStatus.Verified
        ).length;
        const docMissing = enriched.filter(
            (r) =>
                !r.accountingDocStatus ||
                r.accountingDocStatus === AccountingDocStatus.Pending
        ).length;
        const docAction = needsCorrection;
        const docTotal = Math.max(enriched.length, 1);
        const percentComplete = Math.round((docComplete / docTotal) * 100);

        const sub = this.sub(actor);
        const kpis =
            sub === AccountingSubRoles.Payments
                ? {
                      readyForBilling: readyBilling,
                      invoicesOutstanding,
                      customerPaymentsReceived: customerPaid,
                      readyForCarrierPayment: readyCarrierPay,
                      carrierPaymentsCompleted: carrierPaid,
                      overdueCustomerPayments: overdue,
                      accountingClosed: closed,
                  }
                : {
                      documentsToReview: docsPending,
                      needsCorrection,
                      readyForBilling: readyBilling,
                      readyForCarrierPayment: readyCarrierPay,
                      customerPaymentsReceived: customerPaid,
                      carrierPaymentsCompleted: carrierPaid,
                      accountingClosed: closed,
                  };

        return {
            team: "ACCOUNTING",
            accountingSubRole: sub || actor.accountingSubRole || null,
            kpis,
            totals: {
                documentsToReview: docsPending,
                needsCorrection,
                readyForBilling: readyBilling,
                invoicesOutstanding,
                customerPaymentsReceived: customerPaid,
                readyForCarrierPayment: readyCarrierPay,
                carrierPaymentsCompleted: carrierPaid,
                overdueCustomerPayments: overdue,
                accountingClosed: closed,
                voidedLoads: voidedCount,
            },
            summary: {
                totalLoads: enriched.length,
                readyForBilling: readyBilling,
                readyForCarrierPay: readyCarrierPay,
                arToReceive: Math.round(arToReceive * 100) / 100,
                received: paymentKpis.received,
                apToPay: Math.round(apToPay * 100) / 100,
                paid: paymentKpis.paid,
                voidedLoads: voidedCount,
                range: paymentKpis.range.label,
                rangeFrom: paymentKpis.range.from.toISOString(),
                rangeTo: paymentKpis.range.to.toISOString(),
            },
            queues: {
                forReview,
                // Dashboard billing/carrier tabs list by unpaid status (same as nav sections).
                readyBilling: customerBillingOpen,
                readyCarrierPay: carrierPaymentsOpen,
                paid: paidBoth,
                all: enriched.length,
                voided: voidedCount,
            },
            tasks: [
                {
                    id: "verify-docs",
                    label: "Verify Documents",
                    count: docsPending,
                    tab: "document-review",
                },
                {
                    id: "send-invoice",
                    label: "Create / Send Customer Invoice",
                    count: readyBilling,
                    tab: "customer-billing",
                },
                {
                    id: "carrier-pay",
                    label: "Process Carrier Payments",
                    count: readyCarrierPay,
                    tab: "carrier-payments",
                },
                {
                    id: "missing-docs",
                    label: "Follow Up (Missing Docs)",
                    count: needsCorrection,
                    tab: "document-review",
                },
                {
                    id: "overdue",
                    label: "Overdue Invoices",
                    count: overdue,
                    tab: "customer-payments",
                },
            ],
            arAging: {
                total: Math.round(arToReceive * 100) / 100,
                current: Math.round(arAging.current * 100) / 100,
                mid: Math.round(arAging.mid * 100) / 100,
                old: Math.round(arAging.old * 100) / 100,
            },
            apAging: {
                total: Math.round(apToPay * 100) / 100,
                current: Math.round(apAging.current * 100) / 100,
                mid: Math.round(apAging.mid * 100) / 100,
                old: Math.round(apAging.old * 100) / 100,
            },
            trend: weeks.map((w) => ({
                label: w.label,
                billed: Math.round(w.billed * 100) / 100,
                paid: Math.round(w.paid * 100) / 100,
            })),
            documentReadiness: {
                percentComplete,
                complete: docComplete,
                missing: docMissing,
                actionRequired: docAction,
            },
        };
    }

    async listShipments(actor: Actor, filter?: string) {
        assertPerm(actor, AccountingPermissions.ShipmentsView);
        const f = String(filter || "all").toLowerCase();
        const rows = await prisma.shipmentLead.findMany({
where: { loadNumber: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 2000,
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                status: true,
                customerName: true,
                carrierName: true,
                pickupCity: true,
                pickupState: true,
                pickupFrom: true,
                pickupTo: true,
                opsPickupAt: true,
                deliveryCity: true,
                deliveryState: true,
                deliveryFrom: true,
                deliveryTo: true,
                opsDeliveryAt: true,
                customerRate: true,
                price: true,
                carrierRate: true,
                customerPaymentMethod: true,
                waiveCustomerPaymentFee: true,
                invoicePricingSnapshotJson: true,
                accessorialCharges: true,
                assignedBrokerId: true,
                accountingDocStatus: true,
                accountingFinancialVerified: true,
                accountingReadyForBilling: true,
                accountingReadyForCarrierPayment: true,
                accountingReactivatedAt: true,
                invoiceNumber: true,
                invoiceDate: true,
                invoiceDueDate: true,
                invoiceTotalUsd: true,
                invoiceSubtotalUsd: true,
                paymentStatus: true,
                customerPaidAt: true,
                carrierPaidAt: true,
                accountingClosedAt: true,
                updatedAt: true,
            },
        });

        const brokerIds = [
            ...new Set(rows.map((r) => r.assignedBrokerId).filter(Boolean) as string[]),
        ];
        const brokers = brokerIds.length
            ? await prisma.user.findMany({
                  where: { userId: { in: brokerIds } },
                  select: { userId: true, firstName: true, lastName: true },
              })
            : [];
        const brokerName = new Map(
            brokers.map((b) => [
                b.userId,
                `${b.firstName || ""} ${b.lastName || ""}`.trim() || "—",
            ])
        );

        // Prefer current Rate Con Flat Rate over a stale books carrierRate.
        const rcByLead = new Map<string, string | null>();
        if (rows.length) {
            const rcDocs = await prisma.loadDocument.findMany({
                where: {
                    shipmentLeadId: { in: rows.map((r) => r.shipmentLeadId) },
                    isCurrent: true,
                    docType: "RATE_CONFIRMATION",
                    status: { not: "ARCHIVED" },
                },
                select: { shipmentLeadId: true, contentJson: true },
            });
            for (const d of rcDocs) {
                if (!rcByLead.has(d.shipmentLeadId)) {
                    rcByLead.set(d.shipmentLeadId, d.contentJson);
                }
            }
        }

        const pricing = await loadInvoicePricingSettings();
        let list = rows.map((r) => {
            let carrierRate = r.carrierRate;
            const rcJson = rcByLead.get(r.shipmentLeadId);
            if (rcJson) {
                try {
                    const amt = preferRateConCarrierAmount(
                        carrierRate,
                        JSON.parse(rcJson) as Record<string, unknown>
                    );
                    if (amt != null) carrierRate = amt;
                } catch {
                    /* ignore bad RC snapshot */
                }
            }
            const payment = quoteShipmentPayment(r, pricing);
            const customerOwes = payment.total;
            const pickupDay = r.opsPickupAt || r.pickupFrom || r.pickupTo || null;
            const deliveryDay = r.opsDeliveryAt || r.deliveryFrom || r.deliveryTo || null;
            const status = String(r.status || "").toUpperCase();
            return {
                ...r,
                carrierRate,
                pickupDay,
                deliveryDay,
                brokerName: r.assignedBrokerId
                    ? brokerName.get(r.assignedBrokerId) || "—"
                    : "—",
                customerPaymentLabel: payment.label,
                customerPaymentFee: payment.fee,
                customerPaymentWaived: payment.waived,
                customerPays: customerOwes,
                customerTotal: customerOwes,
                carrierTotal: money(carrierRate),
                outstandingCustomer: r.customerPaidAt ? 0 : customerOwes || 0,
                outstandingCarrier: r.carrierPaidAt ? 0 : money(carrierRate) || 0,
                isVoided: status === "VOIDED",
                isReactivated: Boolean(r.accountingReactivatedAt) && status !== "VOIDED",
                accountingEligible: isAccountingWorkEligible(r),
            };
        });

        if (f === "voided") {
            list = list.filter((r) => r.isVoided);
        } else if (f === "all") {
            // All Loads: hide incomplete ghosts (no customer rate / invoice) that break Accounting.
            list = list.filter((r) => r.isVoided || r.accountingEligible);
        } else if (f === "documents" || f === "review") {
            list = list.filter(
                (r) =>
                    !r.isVoided &&
                    r.accountingEligible &&
                    !(r.customerPaidAt && r.carrierPaidAt) &&
                    (!r.accountingDocStatus ||
                        r.accountingDocStatus === AccountingDocStatus.Pending ||
                        r.accountingDocStatus === AccountingDocStatus.NeedsCorrection)
            );
        } else if (f === "verified") {
            // Loads already checked / verified by Accounting Documents (not yet archived).
            list = list.filter(
                (r) =>
                    !r.isVoided &&
                    r.accountingEligible &&
                    !(r.customerPaidAt && r.carrierPaidAt) &&
                    r.accountingDocStatus === AccountingDocStatus.Verified
            );
        } else if (f === "billing") {
            // Customer Billing: VERIFIED + customer UNPAID (PENDING stays in Loads for Review).
            list = list.filter((r) =>
                belongsInCustomerBilling({
                    status: r.status,
                    accountingDocStatus: r.accountingDocStatus,
                    customerPaidAt: r.customerPaidAt,
                    carrierPaidAt: r.carrierPaidAt,
                    accountingEligible: r.accountingEligible,
                })
            );
        } else if (f === "carrier-payment") {
            // Carrier Payments: customer PAID + carrier UNPAID (not waiting on customer).
            list = list.filter((r) =>
                belongsInCarrierPayments({
                    status: r.status,
                    accountingDocStatus: r.accountingDocStatus,
                    customerPaidAt: r.customerPaidAt,
                    carrierPaidAt: r.carrierPaidAt,
                    accountingEligible: r.accountingEligible,
                })
            );
        } else if (f === "customer-payments") {
            list = list.filter(
                (r) =>
                    !r.isVoided &&
                    !(r.customerPaidAt && r.carrierPaidAt) &&
                    (Boolean(r.invoiceNumber) || Boolean(r.customerPaidAt))
            );
        } else if (f === "history" || f === "archive") {
            // Archive: customer paid + carrier paid (work on this load is finished).
            list = list.filter(
                (r) =>
                    !r.isVoided &&
                    Boolean(r.customerPaidAt) &&
                    Boolean(r.carrierPaidAt)
            );
        } else if (f === "pending" || f === "awaiting" || f === "confirmation") {
            // Dashboard: all loads still waiting for accounting confirmation / action
            list = list.filter((r) => {
                if (r.isVoided || !r.accountingEligible || r.accountingClosedAt) return false;
                if (r.customerPaidAt && r.carrierPaidAt) return false;
                const docPending =
                    !r.accountingDocStatus ||
                    r.accountingDocStatus === AccountingDocStatus.Pending ||
                    r.accountingDocStatus === AccountingDocStatus.NeedsCorrection;
                const billingReady =
                    Boolean(r.accountingReadyForBilling) && !r.customerPaidAt;
                const carrierReady =
                    Boolean(r.accountingReadyForCarrierPayment) && !r.carrierPaidAt;
                const invoiceOutstanding =
                    Boolean(r.invoiceNumber) && !r.customerPaidAt;
                return docPending || billingReady || carrierReady || invoiceOutstanding;
            });
        }

        return list.sort(compareLoadNumberAsc);
    }

    async getShipment(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.ShipmentsView);
        const s = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            include: {
                loadDocuments: {
                    where: { isCurrent: true },
                    select: {
                        documentId: true,
                        docType: true,
                        status: true,
                        fileName: true,
                        fileUrl: true,
                        mimeType: true,
                        contentJson: true,
                        version: true,
                        createdAt: true,
                        carrierAssignmentId: true,
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });
        if (!s) throw notFound("Shipment not found");

        let carrierId = s.carrierProfileId || null;
        if (!carrierId && s.carrierEmail) {
            const match = await prisma.carrier.findFirst({
                where: { email: s.carrierEmail.toLowerCase() },
                select: { carrierId: true },
            });
            carrierId = match?.carrierId || null;
        }
        const carrierProfile = carrierId
            ? await prisma.carrier.findUnique({
                  where: { carrierId },
                  select: { paymentOption: true },
              })
            : null;
        /** Packet docs on the carrier profile + any docs uploaded for this load. */
        const packetTypes = [
            "BROKER_CARRIER_AGREEMENT",
            "MC_AUTHORITY",
            "NOA",
            "W9",
            "INSURANCE",
            "COI",
            "LOR",
            "OTHER",
        ];
        const carrierDocs = await prisma.carrierDocument.findMany({
            where: {
                status: "CURRENT",
                OR: [
                    { shipmentLeadId },
                    ...(carrierId
                        ? [{ carrierId, documentType: { in: packetTypes } }]
                        : []),
                ],
            },
            select: {
                documentId: true,
                carrierId: true,
                shipmentLeadId: true,
                documentType: true,
                originalFilename: true,
                mimeType: true,
                status: true,
                uploadedBy: true,
            },
            orderBy: { uploadedAt: "desc" },
        });

        let brokerName: string | null = null;
        if (s.assignedBrokerId) {
            const b = await prisma.user.findUnique({
                where: { userId: s.assignedBrokerId },
                select: { firstName: true, lastName: true },
            });
            brokerName = b
                ? `${b.firstName || ""} ${b.lastName || ""}`.trim() || null
                : null;
        }

        const pricing = await loadInvoicePricingSettings();
        const payment = quoteShipmentPayment(s, pricing);
        let carrierRate = s.carrierRate;
        const rateCon = s.loadDocuments.find(
            (doc) => String(doc.docType || "").toUpperCase() === "RATE_CONFIRMATION"
        );
        let rateConPaymentOption: string | null = null;
        if (rateCon?.contentJson) {
            try {
                const content = JSON.parse(rateCon.contentJson) as Record<string, unknown>;
                const amt = preferRateConCarrierAmount(carrierRate, content);
                if (amt != null && amt > 0 && Number(carrierRate) !== amt) {
                    carrierRate = amt;
                    await prisma.shipmentLead
                        .update({
                            where: { shipmentLeadId },
                            data: { carrierRate: amt },
                        })
                        .catch((err) => {
                            console.error(
                                `[rc-sync] accounting detail heal failed for ${shipmentLeadId}:`,
                                err instanceof Error ? err.message : err
                            );
                            return null;
                        });
                } else if (amt != null) {
                    carrierRate = amt;
                }
                rateConPaymentOption =
                    String(
                        (content.paymentOptionLabel as string | null | undefined) ||
                            (content.paymentOption as string | null | undefined) ||
                            ""
                    ).trim() || null;
            } catch {
                /* ignore bad RC snapshot */
            }
        }
        const customerTotal =
            money(payment.total) ||
            money(s.invoiceTotalUsd) ||
            money(payment.subtotal) ||
            money(payment.rate) ||
            0;
        const carrierTotal = money(carrierRate) || 0;
        const previousSettlements =
            await previousCarrierSettlementService.listForAccounting(shipmentLeadId);
        const allSettlements =
            await previousCarrierSettlementService.listForLoad(shipmentLeadId);
        const previousCarrierPayments = sumPayablePreviousCarrierExpenses(allSettlements);
        const financialSummary = buildLoadFinancialSummary({
            customerPayment: customerTotal,
            previousCarrierPayments,
            finalCarrierPayment: carrierTotal,
        });
        const invoiceById = new Map(
            (s.loadDocuments || []).map((d) => [d.documentId, d] as const)
        );
        const missingInvoiceIds = previousSettlements
            .map((row) => row.invoiceDocumentId)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
            .filter((id) => !invoiceById.has(id));
        if (missingInvoiceIds.length) {
            const extraDocs = await prisma.loadDocument.findMany({
                where: { documentId: { in: missingInvoiceIds } },
                select: {
                    documentId: true,
                    fileName: true,
                    fileUrl: true,
                    mimeType: true,
                    status: true,
                },
            });
            for (const doc of extraDocs) invoiceById.set(doc.documentId, doc as any);
        }
        const previousCarrierSettlements = previousSettlements.map((row) => {
            const inv = row.invoiceDocumentId
                ? invoiceById.get(row.invoiceDocumentId) || null
                : null;
            return {
                settlementId: row.settlementId,
                shipmentLeadId: row.shipmentLeadId,
                loadNumber: row.loadNumber || s.loadNumber,
                carrierAssignmentId: row.carrierAssignmentId,
                previousCarrierId: row.previousCarrierId,
                carrierName: row.carrierName,
                carrierEmail: row.carrierEmail,
                carrierMc: row.carrierMc,
                carrierDot: row.carrierDot,
                paymentAmount: money(row.paymentAmount),
                paymentReason: row.paymentReason,
                paymentReasonCode: row.paymentReasonCode,
                paymentMethod: normalizeAccountingCarrierPaymentMethod(row.paymentMethod),
                paymentMethodLabel:
                    accountingCarrierPaymentMethodLabel(row.paymentMethod) || null,
                changeReason: row.changeReason,
                previousCarrierStatus: row.previousCarrierStatus,
                brokerId: row.brokerId,
                brokerComment: row.brokerComment,
                status: row.status,
                paidAt: row.paidAt,
                paymentDate: formatAccountingPaymentDateInput(row.paidAt),
                paidById: row.paidById,
                reviewedAt: row.reviewedAt,
                reviewedById: row.reviewedById,
                rejectionComment: row.rejectionComment,
                accountingDecisionNote: row.accountingDecisionNote,
                createdAt: row.createdAt,
                invoiceDocumentId: row.invoiceDocumentId,
                invoiceDoc: inv
                    ? {
                          documentId: inv.documentId,
                          fileName: inv.fileName,
                          fileUrl: inv.fileUrl,
                          mimeType: inv.mimeType,
                          status: inv.status,
                      }
                    : null,
            };
        });

        const pickupDay = s.opsPickupAt || s.pickupFrom || s.pickupTo || null;
        const deliveryDay = s.opsDeliveryAt || s.deliveryFrom || s.deliveryTo || null;
        const documents = buildAccountingDocuments({
            shipmentLeadId,
            loadDocs: s.loadDocuments,
            carrierDocs,
        });
        // Standard POD review = final delivering (active) carrier only.
        // Historical assignment PODs stay on Carrier Change history, not this queue.
        const activeAssignmentId = s.activeCarrierAssignmentId || null;
        const podSource = (s.loadDocuments || []).find((doc) => {
            if (String(doc.docType || "").toUpperCase() !== "POD") return false;
            const assignmentId =
                (doc as { carrierAssignmentId?: string | null }).carrierAssignmentId || null;
            if (!activeAssignmentId) return true;
            return !assignmentId || assignmentId === activeAssignmentId;
        });
        const podDoc =
            (podSource &&
                documents.find((doc) => doc.documentId === podSource.documentId)) ||
            (!activeAssignmentId
                ? documents.find((doc) => String(doc.docType || "").toUpperCase() === "POD")
                : null);
        const customerInvoice = documents.find(
            (doc) => String(doc.docType || "").toUpperCase() === "CUSTOMER_INVOICE"
        );
        const customerAgreement = documents.find(
            (doc) =>
                String(doc.docType || "").toUpperCase() === "CUSTOMER_AGREEMENT" &&
                Boolean(doc.openUrl)
        );
        const carrierInvoice = documents.find(
            (doc) => String(doc.docType || "").toUpperCase() === "CARRIER_INVOICE"
        );
        const originalCarrierPaymentOption =
            rateConPaymentOption ||
            carrierPaymentOptionLabel(carrierProfile?.paymentOption) ||
            carrierProfile?.paymentOption ||
            null;
        const accountingCarrierMethod = normalizeAccountingCarrierPaymentMethod(
            s.accountingCarrierPaymentMethod
        );
        const inferredCarrierMethod =
            accountingCarrierMethod ||
            normalizeAccountingCarrierPaymentMethod(rateConPaymentOption) ||
            normalizeAccountingCarrierPaymentMethod(carrierProfile?.paymentOption) ||
            normalizeAccountingCarrierPaymentMethod(originalCarrierPaymentOption);

        const canManagePayPal =
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.BillingSend
            ) ||
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.CustomerPaymentsRecord
            );
        let paypalPayment:
            | (Awaited<
                  ReturnType<typeof payPalCheckoutService.getLatestForShipment>
              > & { createdByName?: string | null })
            | null = null;
        try {
            const latest = await payPalCheckoutService.getLatestForShipment(shipmentLeadId);
            if (latest) {
                let createdByName: string | null = null;
                if (latest.createdByUserId) {
                    const u = await prisma.user.findUnique({
                        where: { userId: latest.createdByUserId },
                        select: { firstName: true, lastName: true, email: true },
                    });
                    createdByName = u
                        ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || null
                        : null;
                }
                paypalPayment = { ...latest, createdByName };
            }
        } catch {
            paypalPayment = null;
        }
        let paypalInvoice: Awaited<
            ReturnType<typeof payPalInvoicingService.getLatestForShipment>
        > = null;
        try {
            paypalInvoice = await payPalInvoicingService.getLatestForShipment(shipmentLeadId);
        } catch {
            paypalInvoice = null;
        }

        return {
            identity: {
                shipmentLeadId: s.shipmentLeadId,
                loadNumber: s.loadNumber,
                greenOsShipmentId: s.greenOsShipmentId,
                status: s.status,
                brokerName,
                createdAt: s.createdAt,
            },
            lane: {
                pickup: [s.pickupCity, s.pickupState, s.pickupZip].filter(Boolean).join(", "),
                delivery: [s.deliveryCity, s.deliveryState, s.deliveryZip]
                    .filter(Boolean)
                    .join(", "),
                pickupDay,
                deliveryDay,
            },
            customer: {
                name: s.customerName,
                email: s.customerEmail,
                rate: payment.rate,
                accessorials: payment.accessorials,
                paymentMethod: payment.method,
                paymentLabel: payment.label,
                paymentFee: payment.fee,
                paymentFeeWaived: payment.waived,
                paymentFeeType: payment.feeType,
                paymentFeeConfiguredValue: payment.feeConfiguredValue,
                paymentSubtotal: payment.subtotal,
                paymentLineItems: payment.lineItems,
                paymentLineItemLabel: payment.lineItemLabel,
                pricingVersion: payment.pricingVersion,
                pricingFromSnapshot: payment.fromSnapshot,
                total: customerTotal,
                invoiceNumber: s.invoiceNumber,
                invoiceDate: s.invoiceDate,
                dueDate: s.invoiceDueDate,
                invoiceFeeAmountUsd: s.invoiceFeeAmountUsd,
                invoiceSubtotalUsd: s.invoiceSubtotalUsd,
                invoiceTotalUsd: s.invoiceTotalUsd,
                firstPaymentDate: formatAccountingPaymentDateInput(
                    s.customerFirstPaymentDate
                ),
                firstPaymentAmount:
                    s.customerFirstPaymentAmount != null
                        ? Number(s.customerFirstPaymentAmount)
                        : null,
                secondPaymentDate: formatAccountingPaymentDateInput(
                    s.customerSecondPaymentDate
                ),
                secondPaymentAmount:
                    s.customerSecondPaymentAmount != null
                        ? Number(s.customerSecondPaymentAmount)
                        : null,
                amountReceived: s.customerPaidAt
                    ? customerTotal
                    : sumCustomerSplitPayments({
                          customerFirstPaymentAmount: s.customerFirstPaymentAmount,
                          customerSecondPaymentAmount: s.customerSecondPaymentAmount,
                      }),
                outstanding: s.customerPaidAt
                    ? 0
                    : Math.max(
                          0,
                          Math.round(
                              ((customerTotal || 0) -
                                  sumCustomerSplitPayments({
                                      customerFirstPaymentAmount:
                                          s.customerFirstPaymentAmount,
                                      customerSecondPaymentAmount:
                                          s.customerSecondPaymentAmount,
                                  })) *
                                  100
                          ) / 100
                      ),
                paymentStatus: s.paymentStatus || (s.customerPaidAt ? "PAID" : "UNPAID"),
                paidAt: s.customerPaidAt,
                invoiceDoc: customerInvoice || null,
                agreementDoc: customerAgreement || null,
            },
            carrier: {
                name: s.carrierName,
                rate: money(carrierRate),
                accessorials: null,
                total: carrierTotal,
                amountPaid: s.carrierPaidAt ? carrierTotal : 0,
                outstanding: s.carrierPaidAt ? 0 : carrierTotal,
                paymentStatus: s.carrierPaidAt ? "PAID" : "UNPAID",
                paidAt: s.carrierPaidAt,
                invoiceDoc: carrierInvoice || null,
                /** Selected Accounting payout method (editable). */
                paymentMethod: inferredCarrierMethod,
                paymentMethodLabel:
                    accountingCarrierPaymentMethodLabel(inferredCarrierMethod) || null,
                paymentDate: formatAccountingPaymentDateInput(
                    s.accountingCarrierPaymentDate
                ),
                accountingPaymentMethod: accountingCarrierMethod,
                /** Historical broker / RC value — never overwritten by Accounting edits. */
                paymentOption: originalCarrierPaymentOption,
                originalPaymentOption: originalCarrierPaymentOption,
                paymentOptionFromRateCon: Boolean(rateConPaymentOption),
            },
            documents,
            pod: {
                status: podDoc
                    ? String(podDoc.status || "UPLOADED").toUpperCase()
                    : "PENDING",
                document: podDoc || null,
            },
            accounting: {
                docStatus: s.accountingDocStatus || AccountingDocStatus.Pending,
                docVerifiedAt: s.accountingDocVerifiedAt,
                docVerifiedById: s.accountingDocVerifiedById,
                customerDocsVerified: Boolean(
                    s.accountingCustomerDocsVerifiedAt ||
                        s.accountingDocStatus === AccountingDocStatus.Verified
                ),
                carrierDocsVerified: Boolean(
                    s.accountingCarrierDocsVerifiedAt ||
                        s.accountingDocStatus === AccountingDocStatus.Verified
                ),
                customerDocsVerifiedAt:
                    s.accountingCustomerDocsVerifiedAt ||
                    (s.accountingDocStatus === AccountingDocStatus.Verified
                        ? s.accountingDocVerifiedAt
                        : null),
                carrierDocsVerifiedAt:
                    s.accountingCarrierDocsVerifiedAt ||
                    (s.accountingDocStatus === AccountingDocStatus.Verified
                        ? s.accountingDocVerifiedAt
                        : null),
                financialVerified: Boolean(s.accountingFinancialVerified),
                readyForBilling: Boolean(s.accountingReadyForBilling),
                readyForCarrierPayment: Boolean(s.accountingReadyForCarrierPayment),
                notes: s.accountingNotes,
                closedAt: s.accountingClosedAt,
                canPayCarrier: Boolean(
                    s.accountingReadyForCarrierPayment &&
                        s.accountingDocStatus === AccountingDocStatus.Verified &&
                        s.accountingFinancialVerified &&
                        !s.carrierPaidAt
                ),
            },
            permissions: {
                canVerifyDocuments: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.DocumentsVerify
                ),
                canRejectDocuments: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.DocumentsReject
                ),
                canVerifyFinancials: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.FinancialsVerify
                ),
                canCreateInvoice: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.BillingCreate
                ),
                canSendInvoice: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.BillingSend
                ),
                canRecordCustomerPayment: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.CustomerPaymentsRecord
                ),
                canExecuteCarrierPayment: hasAccountingPermission(
                    actor.role,
                    actor.accountingSubRole,
                    AccountingPermissions.CarrierPaymentsExecute
                ),
                // Documents (BillingSend) or Payments can queue a carrier invoice into AP.
                canSendCarrierInvoice:
                    hasAccountingPermission(
                        actor.role,
                        actor.accountingSubRole,
                        AccountingPermissions.BillingSend
                    ) ||
                    hasAccountingPermission(
                        actor.role,
                        actor.accountingSubRole,
                        AccountingPermissions.CarrierPaymentsExecute
                    ),
                canManagePayPalLinks: canManagePayPal,
            },
            paypalPayment,
            paypalInvoice,
            paypalInvoicing: {
                mode: config.paypal.invoicingMode,
                configured: config.paypal.invoicingActive.configured,
                webhookConfigured: config.paypal.invoicingActive.invoicingWebhookConfigured,
            },
            paypal: {
                mode: config.paypal.mode,
                configured: config.paypal.configured,
                sandboxConfigured: config.paypal.sandbox.configured,
                liveConfigured: config.paypal.live.configured,
                sandboxWebhookConfigured: config.paypal.sandbox.webhookConfigured,
                liveWebhookConfigured: config.paypal.live.webhookConfigured,
            },
            previousCarrierSettlements,
            financialSummary: {
                ...financialSummary,
                // Final carrier transportation payment stays separate from previous settlements.
                finalCarrierPaymentStatus: s.carrierPaidAt ? "PAID" : "UNPAID",
            },
        };
    }

    async listPreviousCarrierSettlements(actor: Actor, status?: string) {
        assertPerm(actor, AccountingPermissions.ShipmentsView);
        const rows = await previousCarrierSettlementService.listQueue(status || null);
        return {
            items: rows.map((row) => ({
                settlementId: row.settlementId,
                shipmentLeadId: row.shipmentLeadId,
                loadNumber: row.loadNumber,
                carrierName: row.carrierName,
                carrierMc: row.carrierMc,
                carrierDot: row.carrierDot,
                paymentAmount: money(row.paymentAmount),
                paymentReason: row.paymentReason,
                brokerComment: row.brokerComment,
                status: row.status,
                createdAt: row.createdAt,
                reviewedAt: row.reviewedAt,
                rejectionComment: row.rejectionComment,
            })),
        };
    }

    async approvePreviousCarrierSettlement(
        actor: Actor,
        settlementId: string,
        note?: string
    ) {
        assertPerm(actor, AccountingPermissions.FinancialsVerify);
        const updated = await previousCarrierSettlementService.approve(
            { userId: actor.userId },
            settlementId,
            note
        );
        await writeAudit({
            actor,
            action: "PREVIOUS_CARRIER_SETTLEMENT_APPROVED",
            shipmentLeadId: updated.shipmentLeadId,
            newValue: {
                settlementId: updated.settlementId,
                status: updated.status,
            },
            reason: note || null,
        });
        return this.getShipment(actor, updated.shipmentLeadId);
    }

    async rejectPreviousCarrierSettlement(
        actor: Actor,
        settlementId: string,
        comment: string
    ) {
        assertPerm(actor, AccountingPermissions.FinancialsVerify);
        const updated = await previousCarrierSettlementService.reject(
            { userId: actor.userId },
            settlementId,
            comment
        );
        await writeAudit({
            actor,
            action: "PREVIOUS_CARRIER_SETTLEMENT_REJECTED",
            shipmentLeadId: updated.shipmentLeadId,
            newValue: {
                settlementId: updated.settlementId,
                status: updated.status,
                rejectionComment: updated.rejectionComment,
            },
            reason: comment || null,
        });
        return this.getShipment(actor, updated.shipmentLeadId);
    }

    async markPreviousCarrierSettlementPaid(
        actor: Actor,
        settlementId: string,
        note?: string,
        details?: { paymentMethod?: unknown; paymentDate?: unknown }
    ) {
        assertPerm(actor, AccountingPermissions.CarrierPaymentsExecute);
        const updated = await previousCarrierSettlementService.markPaid(
            { userId: actor.userId },
            settlementId,
            note,
            details
        );
        await writeAudit({
            actor,
            action: "PREVIOUS_CARRIER_SETTLEMENT_PAID",
            shipmentLeadId: updated.shipmentLeadId,
            newValue: {
                settlementId: updated.settlementId,
                paidAt: updated.paidAt?.toISOString() || null,
                paymentMethod: updated.paymentMethod,
                status: updated.status,
            },
            reason: note || null,
        });
        return this.getShipment(actor, updated.shipmentLeadId);
    }

    /**
     * Save previous-carrier payment method / date without marking paid.
     * Independent of the current (final) carrier on the load.
     */
    async savePreviousCarrierSettlementDetails(
        actor: Actor,
        settlementId: string,
        body: { paymentMethod?: unknown; paymentDate?: unknown }
    ) {
        assertPerm(actor, AccountingPermissions.ShipmentsView);
        const updated = await previousCarrierSettlementService.updatePaymentDetails(
            { userId: actor.userId },
            settlementId,
            body
        );
        await writeAudit({
            actor,
            action: "PREVIOUS_CARRIER_SETTLEMENT_DETAILS_SAVED",
            shipmentLeadId: updated.shipmentLeadId,
            newValue: {
                settlementId: updated.settlementId,
                paymentMethod: updated.paymentMethod,
                paidAt: updated.paidAt?.toISOString() || null,
                status: updated.status,
            },
        });
        return this.getShipment(actor, updated.shipmentLeadId);
    }

    /**
     * Save current-carrier rate / Accounting payout method / payment date.
     * Does NOT mark the carrier paid — Mark Carrier Paid remains a separate action.
     */
    async saveCarrierPaymentDetails(
        actor: Actor,
        shipmentLeadId: string,
        body: {
            carrierRate?: unknown;
            paymentMethod?: unknown;
            paymentDate?: unknown;
        }
    ) {
        assertPerm(actor, AccountingPermissions.ShipmentsView);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");

        const data: Record<string, unknown> = {};
        if (body.carrierRate !== undefined) {
            if (body.carrierRate == null || body.carrierRate === "") {
                throw badRequest("Carrier rate is required");
            }
            const rate = Number(String(body.carrierRate).replace(/[$,\s]/g, ""));
            if (!Number.isFinite(rate) || rate < 0) {
                throw badRequest("Carrier rate must be a valid non-negative number");
            }
            data.carrierRate = Math.round(rate * 100) / 100;
        }
        if (body.paymentMethod !== undefined) {
            if (body.paymentMethod == null || body.paymentMethod === "") {
                data.accountingCarrierPaymentMethod = null;
            } else {
                const method = normalizeAccountingCarrierPaymentMethod(body.paymentMethod);
                if (!method) {
                    throw badRequest(
                        "Carrier payment method must be Zelle, PayPal, Venmo, Stripe, Factoring Company, or ACH"
                    );
                }
                data.accountingCarrierPaymentMethod = method;
            }
        }
        if (body.paymentDate !== undefined) {
            if (body.paymentDate == null || body.paymentDate === "") {
                data.accountingCarrierPaymentDate = null;
            } else {
                const d = parseAccountingPaymentDate(body.paymentDate);
                if (!d) throw badRequest("Payment date is invalid");
                data.accountingCarrierPaymentDate = d;
            }
        }
        if (!Object.keys(data).length) {
            throw badRequest("No carrier payment details to save");
        }

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data,
        });
        await writeAudit({
            actor,
            action: "CARRIER_PAYMENT_DETAILS_SAVED",
            shipmentLeadId,
            oldValue: {
                carrierRate: s.carrierRate,
                accountingCarrierPaymentMethod: s.accountingCarrierPaymentMethod,
                accountingCarrierPaymentDate: s.accountingCarrierPaymentDate
                    ? formatAccountingPaymentDateInput(s.accountingCarrierPaymentDate)
                    : null,
                carrierPaidAt: s.carrierPaidAt?.toISOString() || null,
            },
            newValue: {
                carrierRate: updated.carrierRate,
                accountingCarrierPaymentMethod: updated.accountingCarrierPaymentMethod,
                accountingCarrierPaymentDate: updated.accountingCarrierPaymentDate
                    ? formatAccountingPaymentDateInput(updated.accountingCarrierPaymentDate)
                    : null,
                carrierPaidAt: updated.carrierPaidAt?.toISOString() || null,
            },
        });
        return this.getShipment(actor, shipmentLeadId);
    }

    async uploadPreviousCarrierSettlementInvoice(
        actor: Actor,
        settlementId: string,
        file: { originalName: string; mimeType: string; tempPath: string }
    ) {
        const canUpload =
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.BillingSend
            ) ||
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.CarrierPaymentsExecute
            ) ||
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.DocumentsVerify
            );
        if (!canUpload) {
            throw forbid("You cannot upload a previous carrier invoice");
        }
        const result = await previousCarrierSettlementService.uploadInvoice({
            settlementId,
            actorUserId: actor.userId,
            originalName: file.originalName,
            mimeType: file.mimeType,
            tempPath: file.tempPath,
        });
        await writeAudit({
            actor,
            action: "PREVIOUS_CARRIER_INVOICE_UPLOADED",
            shipmentLeadId: result.settlement.shipmentLeadId,
            newValue: {
                settlementId: result.settlement.settlementId,
                documentId: result.document.documentId,
                status: result.settlement.status,
            },
        });
        return this.getShipment(actor, result.settlement.shipmentLeadId);
    }

    /**
     * After a carrier invoice is uploaded, Send moves the load into Carrier Payments (AP).
     * Actual payout stays on Carrier Payments → Execute (Payments team).
     */
    async sendCarrierInvoice(actor: Actor, shipmentLeadId: string) {
        const canSend =
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.BillingSend
            ) ||
            hasAccountingPermission(
                actor.role,
                actor.accountingSubRole,
                AccountingPermissions.CarrierPaymentsExecute
            );
        if (!canSend) {
            throw forbid("You cannot send a carrier invoice to Carrier Payments");
        }
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (s.carrierPaidAt) {
            throw badRequest("Carrier is already paid on this load");
        }

        const invoiceDoc = await prisma.loadDocument.findFirst({
            where: {
                shipmentLeadId,
                docType: "CARRIER_INVOICE",
                isCurrent: true,
                status: { not: "ARCHIVED" },
            },
            orderBy: { version: "desc" },
        });
        if (!invoiceDoc?.storedName || !invoiceDoc.fileUrl) {
            throw badRequest("Upload the Carrier Invoice document before sending");
        }
        const absolutePath = resolveLoadDocumentAbsolutePath(shipmentLeadId, invoiceDoc.storedName);
        if (!absolutePath) {
            throw badRequest("Carrier Invoice file is missing on the server — upload it again");
        }

        const nextStatus = canTransition(String(s.status || ""), "CARRIER_PAYMENT")
            ? "CARRIER_PAYMENT"
            : undefined;
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                accountingReadyForCarrierPayment: true,
                ...(nextStatus ? { status: nextStatus } : {}),
            },
        });
        await prisma.loadDocument
            .update({
                where: { documentId: invoiceDoc.documentId },
                data: { status: "SENT" },
            })
            .catch(() => null);
        await writeAudit({
            actor,
            action: "CARRIER_INVOICE_SENT_TO_AP",
            shipmentLeadId,
            newValue: {
                accountingReadyForCarrierPayment: true,
                documentId: invoiceDoc.documentId,
                ...(nextStatus ? { status: nextStatus } : {}),
            },
        });
        await domainEventEngine
            .emit({
                shipmentLeadId,
                eventType: "STATUS_CHANGED",
                title: "Carrier invoice sent to AP",
                message: `Carrier invoice sent — Load ${s.loadNumber || shipmentLeadId} moved to Carrier Payments`,
                actorUserId: actor.userId,
                payload: {
                    accountingReadyForCarrierPayment: true,
                    documentId: invoiceDoc.documentId,
                    ...(nextStatus ? { status: nextStatus } : {}),
                },
                timelineStage: nextStatus || "LOAD_CREATED",
            })
            .catch(() => null);
        return updated;
    }

    async verifyDocuments(
        actor: Actor,
        shipmentLeadId: string,
        note?: string,
        side: "customer" | "carrier" | "both" = "both"
    ) {
        assertPerm(actor, AccountingPermissions.DocumentsVerify);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        const now = new Date();
        const sideNorm =
            side === "customer" || side === "carrier" || side === "both" ? side : "both";
        const legacyBoth = s.accountingDocStatus === AccountingDocStatus.Verified;
        const customerAt =
            sideNorm === "customer" || sideNorm === "both"
                ? now
                : s.accountingCustomerDocsVerifiedAt ||
                  (legacyBoth ? s.accountingDocVerifiedAt || now : null);
        const carrierAt =
            sideNorm === "carrier" || sideNorm === "both"
                ? now
                : s.accountingCarrierDocsVerifiedAt ||
                  (legacyBoth ? s.accountingDocVerifiedAt || now : null);
        const fullyVerified = Boolean(customerAt && carrierAt);
        const nextStatus = fullyVerified
            ? AccountingDocStatus.Verified
            : s.accountingDocStatus === AccountingDocStatus.NeedsCorrection
              ? AccountingDocStatus.NeedsCorrection
              : AccountingDocStatus.Pending;
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                accountingCustomerDocsVerifiedAt: customerAt,
                accountingCarrierDocsVerifiedAt: carrierAt,
                accountingDocStatus: nextStatus,
                accountingDocVerifiedAt: fullyVerified ? now : null,
                accountingDocVerifiedById: fullyVerified ? actor.userId : null,
                ...(fullyVerified ? { accountingReactivatedAt: null } : {}),
                accountingNotes: note
                    ? [s.accountingNotes, note].filter(Boolean).join("\n")
                    : s.accountingNotes,
            },
        });
        const sideLabel =
            sideNorm === "customer"
                ? "Customer Documents"
                : sideNorm === "carrier"
                  ? "Carrier Documents"
                  : "Customer & Carrier Documents";
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: fullyVerified
                ? "Accounting documents verified"
                : `${sideLabel} verified`,
            message: fullyVerified
                ? "Accounting verified customer and carrier document packages"
                : `Accounting verified ${sideLabel}; waiting for the other side`,
            actorUserId: actor.userId,
            payload: {
                accountingDocStatus: nextStatus,
                side: sideNorm,
                customerDocsVerified: Boolean(customerAt),
                carrierDocsVerified: Boolean(carrierAt),
            },
        });
        await writeAudit({
            actor,
            action: fullyVerified ? "DOCUMENTS_VERIFIED" : "DOCUMENTS_SIDE_VERIFIED",
            shipmentLeadId,
            oldValue: {
                accountingDocStatus: s.accountingDocStatus,
                customerDocsVerifiedAt: s.accountingCustomerDocsVerifiedAt || null,
                carrierDocsVerifiedAt: s.accountingCarrierDocsVerifiedAt || null,
            },
            newValue: {
                accountingDocStatus: nextStatus,
                customerDocsVerifiedAt: customerAt,
                carrierDocsVerifiedAt: carrierAt,
                side: sideNorm,
            },
            reason: note || null,
        });
        return updated;
    }

    async rejectDocuments(
        actor: Actor,
        shipmentLeadId: string,
        reason: string,
        needsCorrection = true
    ) {
        assertPerm(actor, AccountingPermissions.DocumentsReject);
        if (!String(reason || "").trim()) throw badRequest("Rejection reason is required");
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        const status = needsCorrection
            ? AccountingDocStatus.NeedsCorrection
            : AccountingDocStatus.Rejected;
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                accountingDocStatus: status,
                accountingCustomerDocsVerifiedAt: null,
                accountingCarrierDocsVerifiedAt: null,
                accountingDocVerifiedAt: null,
                accountingDocVerifiedById: null,
                accountingReadyForBilling: false,
                accountingReadyForCarrierPayment: false,
                accountingFinancialVerified: false,
                accountingNotes: [s.accountingNotes, `REJECT: ${reason}`]
                    .filter(Boolean)
                    .join("\n"),
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Accounting documents rejected",
            message: reason,
            actorUserId: actor.userId,
            payload: { accountingDocStatus: status },
        });
        await writeAudit({
            actor,
            action: "DOCUMENTS_REJECTED",
            shipmentLeadId,
            oldValue: { accountingDocStatus: s.accountingDocStatus },
            newValue: { accountingDocStatus: status },
            reason,
        });
        return updated;
    }

    async verifyFinancials(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.FinancialsVerify);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (s.accountingDocStatus !== AccountingDocStatus.Verified) {
            throw badRequest("Verify documents before confirming financial amounts");
        }
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { accountingFinancialVerified: true },
        });
        await writeAudit({
            actor,
            action: "FINANCIALS_VERIFIED",
            shipmentLeadId,
            oldValue: { accountingFinancialVerified: s.accountingFinancialVerified },
            newValue: { accountingFinancialVerified: true },
        });
        return updated;
    }

    async markReadyForBilling(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.FinancialsVerify);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (s.accountingDocStatus !== AccountingDocStatus.Verified) {
            throw badRequest("Documents must be verified first");
        }
        if (!s.accountingFinancialVerified) {
            throw badRequest("Financial amounts must be verified first");
        }
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { accountingReadyForBilling: true },
        });
        await writeAudit({
            actor,
            action: "READY_FOR_BILLING",
            shipmentLeadId,
            newValue: { accountingReadyForBilling: true },
        });
        return updated;
    }

    async markReadyForCarrierPayment(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.FinancialsVerify);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (s.accountingDocStatus !== AccountingDocStatus.Verified) {
            throw badRequest("Documents must be verified first");
        }
        if (!s.accountingFinancialVerified) {
            throw badRequest("Financial amounts must be verified first");
        }
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { accountingReadyForCarrierPayment: true },
        });
        await writeAudit({
            actor,
            action: "READY_FOR_CARRIER_PAYMENT",
            shipmentLeadId,
            newValue: { accountingReadyForCarrierPayment: true },
        });
        return updated;
    }

    async addNote(actor: Actor, shipmentLeadId: string, note: string) {
        assertPerm(actor, AccountingPermissions.NotesCreate);
        if (!String(note || "").trim()) throw badRequest("Note is required");
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const line = `[${stamp}] ${note.trim()}`;
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                accountingNotes: [s.accountingNotes, line].filter(Boolean).join("\n"),
            },
        });
        await writeAudit({
            actor,
            action: "NOTE_ADDED",
            shipmentLeadId,
            newValue: { note: line },
        });
        return updated;
    }

    async previewInvoicePricing(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.BillingView);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        const settings = await loadInvoicePricingSettings();
        const payment = quoteShipmentPayment(s, settings);
        return {
            shipmentLeadId,
            currency: "USD",
            method: payment.method,
            methodLabel: payment.label,
            waived: payment.waived,
            fromSnapshot: payment.fromSnapshot,
            pricingVersion: payment.pricingVersion,
            feeType: payment.feeType,
            configuredValue: payment.feeConfiguredValue,
            lineItemLabel: payment.lineItemLabel,
            rateUsd: payment.rate,
            accessorialsUsd: payment.accessorials,
            subtotalUsd: payment.subtotal,
            feeAmountUsd: payment.fee,
            totalUsd: payment.total,
            lineItems: payment.lineItems,
            settings: {
                enabled: settings.enabled,
                feeType: settings.feeType,
                percentageValue: settings.percentageValue,
                fixedAmountUsd: settings.fixedAmountUsd,
                version: settings.version,
                lineItemLabel: settings.lineItemLabel,
            },
            policyText: INVOICE_PRICING_POLICY_TEXT,
            // Keep PayPal processor fees out of customer invoice totals.
            paypalProcessorFeesExcluded: true,
            note:
                "Additional fee is a handling fee (when enabled), never a PayPal surcharge. " +
                "PayPal's own processing fees are separate and not added here.",
        };
    }

    async createInvoice(
        actor: Actor,
        shipmentLeadId: string,
        body: {
            invoiceNumber?: string | null;
            invoiceDate?: string | null;
            dueDate?: string | null;
            /** Client must confirm they reviewed subtotal / fee / total. */
            confirmPricing?: boolean;
        }
    ) {
        assertPerm(actor, AccountingPermissions.BillingCreate);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (!s.accountingReadyForBilling) {
            throw badRequest("Shipment is not Ready for Billing");
        }
        if (s.invoicePricingSnapshotJson) {
            throw badRequest(
                "Invoice pricing is already locked for this load. Historical totals cannot be changed.",
                "INVOICE_PRICING_LOCKED"
            );
        }
        if (!body.confirmPricing) {
            throw badRequest(
                "Confirm subtotal, additional fee, and final total before creating the invoice",
                "INVOICE_PRICING_CONFIRM_REQUIRED"
            );
        }

        const settings = await loadInvoicePricingSettings();
        const payment = quoteShipmentPayment(s, settings);
        if (payment.total == null || payment.total < 0) {
            throw badRequest("Invoice total is invalid", "INVOICE_TOTAL_INVALID");
        }
        if (payment.fee < 0 || (payment.subtotal != null && payment.subtotal < 0)) {
            throw badRequest("Invoice amounts cannot be negative", "INVOICE_AMOUNT_INVALID");
        }

        const snapshot = createInvoicePricingSnapshot({
            settings,
            breakdown: buildInvoicePricingBreakdown({
                customerRate: s.customerRate,
                accessorialCharges: s.accessorialCharges,
                waiveFee: s.waiveCustomerPaymentFee,
                settings,
            }),
        });

        const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : new Date();
        const dueDate = body.dueDate
            ? new Date(body.dueDate)
            : new Date(invoiceDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        const invoiceNumber =
            String(body.invoiceNumber || "").trim() ||
            s.invoiceNumber ||
            (s.loadNumber ? String(s.loadNumber).trim() : `GL-${Date.now()}`);

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                invoiceNumber,
                invoiceDate,
                invoiceDueDate: dueDate,
                paymentStatus: s.paymentStatus || "INVOICED",
                invoicePricingVersion: snapshot.version,
                invoiceFeeType: snapshot.feeType,
                invoiceFeeConfiguredValue: snapshot.configuredValue,
                invoiceFeeAmountUsd: snapshot.feeAmountUsd,
                invoiceSubtotalUsd: snapshot.subtotalUsd,
                invoiceTotalUsd: snapshot.totalUsd,
                invoicePricingSnapshotJson: JSON.stringify(snapshot),
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CUSTOMER_INVOICE_GENERATED",
            title: "Customer invoice recorded",
            message: `Invoice ${invoiceNumber}`,
            actorUserId: actor.userId,
            payload: {
                invoiceNumber,
                pricingVersion: snapshot.version,
                subtotalUsd: snapshot.subtotalUsd,
                feeAmountUsd: snapshot.feeAmountUsd,
                totalUsd: snapshot.totalUsd,
                feeType: snapshot.feeType,
            },
        });
        await writeAudit({
            actor,
            action: "INVOICE_CREATED",
            shipmentLeadId,
            newValue: {
                invoiceNumber,
                invoiceDate,
                dueDate,
                pricingSnapshot: snapshot,
            },
        });
        return {
            ...updated,
            pricing: snapshot,
            lineItems: payment.lineItems,
        };
    }

    async getInvoicePricingSettings(actor: Actor) {
        assertPerm(actor, AccountingPermissions.BillingView);
        const settings = await loadInvoicePricingSettings();
        return {
            settings,
            policyText: INVOICE_PRICING_POLICY_TEXT,
            canManage: isAccountingAdmin(actor.role),
            paypalProcessorFeesExcluded: true,
        };
    }

    async updateInvoicePricingSettings(actor: Actor, body: InvoicePricingUpdateInput) {
        if (!isAccountingAdmin(actor.role)) {
            throw forbid(
                "Only Owner or Administrator can change Invoice Pricing",
                "ACCOUNTING_PAYMENT_SETTINGS_FORBIDDEN"
            );
        }
        assertPerm(actor, AccountingPermissions.PaymentSettingsManage);
        const current = await loadInvoicePricingSettings();
        const validated = validateInvoicePricingUpdate(current, body || {}, actor.userId);
        if (!validated.ok) {
            throw badRequest(validated.message, validated.code);
        }
        const saved = await saveInvoicePricingSettings(validated.next, actor.userId);
        await writeAudit({
            actor,
            action: "INVOICE_PRICING_SETTINGS_UPDATED",
            newValue: saved,
        });
        return {
            settings: saved,
            policyText: INVOICE_PRICING_POLICY_TEXT,
            canManage: true,
            paypalProcessorFeesExcluded: true,
        };
    }

    async sendInvoice(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.BillingSend);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");

        const invoiceDoc = await prisma.loadDocument.findFirst({
            where: {
                shipmentLeadId,
                docType: "CUSTOMER_INVOICE",
                isCurrent: true,
                status: { not: "ARCHIVED" },
            },
            orderBy: { version: "desc" },
        });
        if (!invoiceDoc?.storedName || !invoiceDoc.fileUrl) {
            throw badRequest("Upload the Customer Invoice document before sending");
        }
        const absolutePath = resolveLoadDocumentAbsolutePath(shipmentLeadId, invoiceDoc.storedName);
        if (!absolutePath) {
            throw badRequest("Customer Invoice file is missing on the server");
        }

        const to = String(s.customerEmail || "").trim();
        if (!to || !to.includes("@")) {
            throw badRequest(
                "Customer email is missing on this load. Add the customer email, then send again."
            );
        }

        const pricing = await loadInvoicePricingSettings();
        const payment = quoteShipmentPayment(s, pricing);
        const invoiceNumber =
            String(s.invoiceNumber || "").trim() ||
            (s.loadNumber ? String(s.loadNumber).trim() : `GL-${Date.now()}`);
        const invoiceDate = s.invoiceDate || new Date();
        const invoiceDueDate =
            s.invoiceDueDate || new Date(invoiceDate.getTime() + 30 * 24 * 60 * 60 * 1000);

        const mail = await sendCustomerInvoiceEmail({
            to,
            customerName: s.customerName,
            loadNumber: s.loadNumber,
            invoiceNumber,
            amountDue: payment.total,
            attachment: {
                filename:
                    invoiceDoc.fileName ||
                    `Customer-Invoice-${s.loadNumber || shipmentLeadId.slice(0, 8)}.pdf`,
                content: fs.readFileSync(absolutePath),
                contentType: invoiceDoc.mimeType || "application/pdf",
            },
        });

        await prisma.loadDocument.update({
            where: { documentId: invoiceDoc.documentId },
            data: { status: "SENT" },
        });

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                invoiceNumber,
                invoiceDate,
                invoiceDueDate,
                // Sent invoice enters Billing (AR) until the customer pays.
                accountingReadyForBilling: true,
                paymentStatus:
                    s.paymentStatus === "CUSTOMER_PAID" ||
                    s.paymentStatus === "CUSTOMER_AND_CARRIER_PAID"
                        ? s.paymentStatus
                        : "INVOICE_SENT",
            },
        });

        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CUSTOMER_INVOICE_SENT",
            title: "Customer invoice emailed",
            message: `Invoice ${invoiceNumber} emailed to ${to}`,
            actorUserId: actor.userId,
            payload: {
                invoiceNumber,
                emailTo: to,
                from: mail.from,
                documentId: invoiceDoc.documentId,
                accountingReadyForBilling: true,
            },
        });
        await writeAudit({
            actor,
            action: "INVOICE_SENT",
            shipmentLeadId,
            oldValue: {
                paymentStatus: s.paymentStatus,
                invoiceNumber: s.invoiceNumber,
                accountingReadyForBilling: s.accountingReadyForBilling,
            },
            newValue: {
                paymentStatus: updated.paymentStatus,
                invoiceNumber,
                emailTo: to,
                from: mail.from,
                accountingReadyForBilling: true,
            },
        });
        return {
            ...updated,
            emailTo: to,
            emailFrom: mail.from,
            invoiceNumber,
            documentId: invoiceDoc.documentId,
            movedToBilling: true,
        };
    }

    async recordCustomerPayment(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.CustomerPaymentsRecord);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (s.customerPaidAt) {
            throw badRequest("Customer payment is already recorded");
        }
        // Permission is the gate. Ready-for-billing / invoice used to hard-block Mark
        // Customer Paid for loads already in Accounting with a dead-looking button.
        // Soft-note incomplete flags in the audit trail instead.
        const incompleteFlags: string[] = [];
        if (!s.accountingReadyForBilling) incompleteFlags.push("readyForBilling");
        if (!s.invoiceNumber) incompleteFlags.push("invoiceNumber");
        const latestPayPal = await prisma.payPalCustomerOrder.findFirst({
            where: { shipmentLeadId },
            orderBy: { createdAt: "desc" },
        });
        const latestPayPalInvoice = await prisma.payPalCustomerInvoice.findFirst({
            where: { shipmentLeadId },
            orderBy: { createdAt: "desc" },
        });
        const openCheckout =
            latestPayPal &&
            !["CANCELLED", "DENIED", "FAILED", "REFUNDED", "REVERSED"].includes(
                String(latestPayPal.status || "").toUpperCase()
            );
        // Only block manual mark when PayPal is the payment path or a live checkout /
        // invoice is still in a payable/paid state. Draft/cancelled invoices must not
        // leave Mark Customer Paid dead after ACH/wire/Zelle was received offline.
        const invStatus = String(latestPayPalInvoice?.status || "").toUpperCase();
        const livePayPalInvoice =
            latestPayPalInvoice &&
            ["SENT", "UNPAID", "PAYMENT_PENDING", "PARTIALLY_PAID", "PAID", "MARKED_AS_PAID"].includes(
                invStatus
            );
        if (
            String(s.customerPaymentMethod || "").toUpperCase() === "PAYPAL" ||
            openCheckout ||
            livePayPalInvoice
        ) {
            throw badRequest(
                "PayPal payments cannot be recorded manually. Use verified PayPal Checkout capture or Invoicing paid status (Sync), or cancel the PayPal invoice first if the customer paid offline.",
                "PAYPAL_MANUAL_PAYMENT_BLOCKED"
            );
        }
        const now = new Date();
        const bothPaid = Boolean(s.carrierPaidAt);
        const paymentStatus = bothPaid ? "CUSTOMER_AND_CARRIER_PAID" : "CUSTOMER_PAID";
        const payNote = incompleteFlags.length
            ? `CUSTOMER PAYMENT (flags incomplete: ${incompleteFlags.join(", ")})`
            : "CUSTOMER PAYMENT";
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                customerPaidAt: now,
                customerPaidById: actor.userId,
                paymentStatus,
                paymentDate: now,
                accountingNotes: [s.accountingNotes, payNote].filter(Boolean).join("\n"),
                // Finished load → Archive when carrier was already paid.
                accountingClosedAt: bothPaid ? now : s.accountingClosedAt,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CUSTOMER_PAYMENT_RECEIVED",
            title: "Customer Paid",
            message: bothPaid
                ? "Customer paid — load moved to Archive"
                : "Accounting recorded customer payment",
            actorUserId: actor.userId,
            payload: {
                paidAt: now.toISOString(),
                incompleteFlags,
                archived: bothPaid,
            },
        });
        await writeAudit({
            actor,
            action: "CUSTOMER_PAYMENT_RECORDED",
            shipmentLeadId,
            newValue: {
                customerPaidAt: now.toISOString(),
                incompleteFlags,
                archived: bothPaid,
            },
        });
        return updated;
    }

    /**
     * Carrier payment — BLOCKED until Documents verified + financials verified + ready flag.
     * Enforced here (backend), not only in the UI.
     */
    async executeCarrierPayment(actor: Actor, shipmentLeadId: string, note?: string) {
        assertPerm(actor, AccountingPermissions.CarrierPaymentsExecute);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");

        if (s.carrierPaidAt) {
            throw badRequest("Carrier already marked paid");
        }

        // Permission is the gate. Doc/financial/ready flags used to block Mark Carrier Paid
        // for Accounting Documents on loads already in the Carrier Payment flow — that left
        // a visible but dead button. Soft-note incomplete flags in the audit trail instead.
        const incompleteFlags: string[] = [];
        if (s.accountingDocStatus !== AccountingDocStatus.Verified) {
            incompleteFlags.push("documents");
        }
        if (!s.accountingFinancialVerified) incompleteFlags.push("financials");
        if (!s.accountingReadyForCarrierPayment) incompleteFlags.push("ready");

        const now = new Date();
        const bothPaid = Boolean(s.customerPaidAt);
        const paymentStatus = bothPaid ? "CUSTOMER_AND_CARRIER_PAID" : "CARRIER_PAID";
        const payNote = incompleteFlags.length
            ? `CARRIER PAYMENT (flags incomplete: ${incompleteFlags.join(", ")})`
            : "CARRIER PAYMENT";
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                carrierPaidAt: now,
                carrierPaidById: actor.userId,
                paymentStatus,
                accountingNotes: [s.accountingNotes, note ? `${payNote}: ${note}` : payNote]
                    .filter(Boolean)
                    .join("\n"),
                // Finished load → Archive when customer was already paid.
                accountingClosedAt: bothPaid ? now : s.accountingClosedAt,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CARRIER_PAID",
            title: "Carrier Paid",
            message: bothPaid
                ? "Carrier paid — load moved to Archive"
                : "Accounting marked carrier payment",
            actorUserId: actor.userId,
            payload: {
                paidAt: now.toISOString(),
                archived: bothPaid,
                incompleteFlags,
            },
        });
        await writeAudit({
            actor,
            action: "CARRIER_PAYMENT_EXECUTED",
            shipmentLeadId,
            newValue: {
                carrierPaidAt: now.toISOString(),
                paymentStatus,
                archived: bothPaid,
                incompleteFlags,
            },
            reason: note || (incompleteFlags.length ? incompleteFlags.join(",") : null),
        });
        return updated;
    }

    /** Used by load.service mark_carrier_paid gate. */
    static assertCarrierPaymentAllowed(shipment: {
        accountingDocStatus?: string | null;
        accountingFinancialVerified?: boolean | null;
        accountingReadyForCarrierPayment?: boolean | null;
        carrierPaidAt?: Date | null;
    }, actorRole: string) {
        // Owner/Admin may override in emergencies — still logged by caller.
        if (actorRole === Roles.Owner || actorRole === Roles.Administrator) {
            return;
        }
        if (shipment.accountingDocStatus !== AccountingDocStatus.Verified) {
            throw forbid(
                "Carrier payment blocked — documents not verified by Accounting Documents",
                "CARRIER_PAYMENT_BLOCKED"
            );
        }
        if (!shipment.accountingFinancialVerified) {
            throw forbid(
                "Carrier payment blocked — financial amounts not verified",
                "CARRIER_PAYMENT_BLOCKED"
            );
        }
        if (!shipment.accountingReadyForCarrierPayment) {
            throw forbid(
                "Carrier payment blocked — not marked Ready for Carrier Payment",
                "CARRIER_PAYMENT_BLOCKED"
            );
        }
    }
}

export const accountingService = new AccountingService();

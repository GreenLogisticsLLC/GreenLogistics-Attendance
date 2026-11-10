import fs from "fs";
import path from "path";
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
import { customerPaymentQuote } from "../../shipment/customer-payment.js";
import { carrierPaymentOptionLabel } from "../../carriers/constants.js";
import { LOAD_DOCS_ROOT } from "../../shipment/services/load-pdf.service.js";

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
                status: { not: "VOIDED" },
            },
            select: {
                shipmentLeadId: true,
                status: true,
                accountingDocStatus: true,
                accountingFinancialVerified: true,
                accountingReadyForBilling: true,
                accountingReadyForCarrierPayment: true,
                customerPaidAt: true,
                carrierPaidAt: true,
                invoiceNumber: true,
                invoiceDate: true,
                invoiceDueDate: true,
                accountingClosedAt: true,
                paymentStatus: true,
                customerRate: true,
                carrierRate: true,
                accessorialCharges: true,
                customerPaymentMethod: true,
                waiveCustomerPaymentFee: true,
                updatedAt: true,
            },
        });

        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const enriched = rows.map((r) => {
            const payment = customerPaymentQuote({
                customerRate: r.customerRate,
                accessorialCharges: r.accessorialCharges,
                method: r.customerPaymentMethod,
                waiveFee: r.waiveCustomerPaymentFee,
            });
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

        const arToReceive = enriched.reduce((sum, r) => sum + (r.outstandingCustomer || 0), 0);
        const apToPay = enriched.reduce((sum, r) => sum + (r.outstandingCarrier || 0), 0);

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
            },
            summary: {
                totalLoads: enriched.length,
                readyForBilling: readyBilling,
                readyForCarrierPay: readyCarrierPay,
                arToReceive: Math.round(arToReceive * 100) / 100,
                apToPay: Math.round(apToPay * 100) / 100,
            },
            queues: {
                forReview,
                readyBilling,
                readyCarrierPay,
                paid: paidBoth,
                all: enriched.length,
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
            where: { loadNumber: { not: null }, status: { not: "VOIDED" } },
            orderBy: { updatedAt: "desc" },
            take: 200,
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
                carrierRate: true,
                customerPaymentMethod: true,
                waiveCustomerPaymentFee: true,
                accessorialCharges: true,
                assignedBrokerId: true,
                accountingDocStatus: true,
                accountingFinancialVerified: true,
                accountingReadyForBilling: true,
                accountingReadyForCarrierPayment: true,
                invoiceNumber: true,
                invoiceDate: true,
                invoiceDueDate: true,
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

        let list = rows.map((r) => {
            const payment = customerPaymentQuote({
                customerRate: r.customerRate,
                accessorialCharges: r.accessorialCharges,
                method: r.customerPaymentMethod,
                waiveFee: r.waiveCustomerPaymentFee,
            });
            const customerOwes = payment.total;
            const pickupDay = r.opsPickupAt || r.pickupFrom || r.pickupTo || null;
            const deliveryDay = r.opsDeliveryAt || r.deliveryFrom || r.deliveryTo || null;
            return {
                ...r,
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
                carrierTotal: money(r.carrierRate),
                outstandingCustomer: r.customerPaidAt ? 0 : customerOwes || 0,
                outstandingCarrier: r.carrierPaidAt ? 0 : money(r.carrierRate) || 0,
            };
        });

        if (f === "documents" || f === "review") {
            list = list.filter(
                (r) =>
                    !r.accountingDocStatus ||
                    r.accountingDocStatus === AccountingDocStatus.Pending ||
                    r.accountingDocStatus === AccountingDocStatus.NeedsCorrection
            );
        } else if (f === "billing") {
            list = list.filter((r) => r.accountingReadyForBilling && !r.customerPaidAt);
        } else if (f === "carrier-payment") {
            list = list.filter(
                (r) => r.accountingReadyForCarrierPayment && !r.carrierPaidAt
            );
        } else if (f === "customer-payments") {
            list = list.filter((r) => Boolean(r.invoiceNumber) || Boolean(r.customerPaidAt));
        } else if (f === "history") {
            list = list.filter(
                (r) => Boolean(r.accountingClosedAt) || Boolean(r.carrierPaidAt)
            );
        } else if (f === "pending" || f === "awaiting" || f === "confirmation") {
            // Dashboard: all loads still waiting for accounting confirmation / action
            list = list.filter((r) => {
                if (r.accountingClosedAt) return false;
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

        return list;
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

        const payment = customerPaymentQuote({
            customerRate: s.customerRate,
            accessorialCharges: s.accessorialCharges,
            method: s.customerPaymentMethod,
            waiveFee: s.waiveCustomerPaymentFee,
        });
        const customerTotal = payment.total || 0;
        const carrierTotal = money(s.carrierRate) || 0;

        const pickupDay = s.opsPickupAt || s.pickupFrom || s.pickupTo || null;
        const deliveryDay = s.opsDeliveryAt || s.deliveryFrom || s.deliveryTo || null;
        const documents = buildAccountingDocuments({
            shipmentLeadId,
            loadDocs: s.loadDocuments,
            carrierDocs,
        });
        const podDoc = documents.find((doc) => String(doc.docType || "").toUpperCase() === "POD");
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

        let rateConPaymentOption: string | null = null;
        const rateCon = s.loadDocuments.find(
            (doc) => String(doc.docType || "").toUpperCase() === "RATE_CONFIRMATION"
        );
        if (rateCon?.contentJson) {
            try {
                const content = JSON.parse(rateCon.contentJson) as {
                    paymentOption?: string | null;
                    paymentOptionLabel?: string | null;
                };
                rateConPaymentOption =
                    String(content.paymentOptionLabel || content.paymentOption || "").trim() ||
                    null;
            } catch {
                /* ignore bad RC snapshot */
            }
        }
        const carrierPaymentOption =
            rateConPaymentOption ||
            carrierPaymentOptionLabel(carrierProfile?.paymentOption) ||
            carrierProfile?.paymentOption ||
            null;

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
                total: customerTotal,
                invoiceNumber: s.invoiceNumber,
                invoiceDate: s.invoiceDate,
                dueDate: s.invoiceDueDate,
                amountReceived: s.customerPaidAt ? customerTotal : 0,
                outstanding: s.customerPaidAt ? 0 : customerTotal,
                paymentStatus: s.paymentStatus || (s.customerPaidAt ? "PAID" : "UNPAID"),
                paidAt: s.customerPaidAt,
                invoiceDoc: customerInvoice || null,
                agreementDoc: customerAgreement || null,
            },
            carrier: {
                name: s.carrierName,
                rate: money(s.carrierRate),
                accessorials: null,
                total: carrierTotal,
                amountPaid: s.carrierPaidAt ? carrierTotal : 0,
                outstanding: s.carrierPaidAt ? 0 : carrierTotal,
                paymentStatus: s.carrierPaidAt ? "PAID" : "UNPAID",
                paidAt: s.carrierPaidAt,
                invoiceDoc: carrierInvoice || null,
                paymentOption: carrierPaymentOption,
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
            },
        };
    }

    async verifyDocuments(actor: Actor, shipmentLeadId: string, note?: string) {
        assertPerm(actor, AccountingPermissions.DocumentsVerify);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        const now = new Date();
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                accountingDocStatus: AccountingDocStatus.Verified,
                accountingDocVerifiedAt: now,
                accountingDocVerifiedById: actor.userId,
                accountingNotes: note
                    ? [s.accountingNotes, note].filter(Boolean).join("\n")
                    : s.accountingNotes,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Accounting documents verified",
            message: "Accounting Documents verified BOL/POD/RC package",
            actorUserId: actor.userId,
            payload: { accountingDocStatus: AccountingDocStatus.Verified },
        });
        await writeAudit({
            actor,
            action: "DOCUMENTS_VERIFIED",
            shipmentLeadId,
            oldValue: { accountingDocStatus: s.accountingDocStatus },
            newValue: { accountingDocStatus: AccountingDocStatus.Verified },
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

    async createInvoice(
        actor: Actor,
        shipmentLeadId: string,
        body: {
            invoiceNumber?: string | null;
            invoiceDate?: string | null;
            dueDate?: string | null;
        }
    ) {
        assertPerm(actor, AccountingPermissions.BillingCreate);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (!s.accountingReadyForBilling) {
            throw badRequest("Shipment is not Ready for Billing");
        }
        const invoiceDate = body.invoiceDate ? new Date(body.invoiceDate) : new Date();
        const dueDate = body.dueDate
            ? new Date(body.dueDate)
            : new Date(invoiceDate.getTime() + 30 * 24 * 60 * 60 * 1000);
        const invoiceNumber =
            String(body.invoiceNumber || "").trim() ||
            s.invoiceNumber ||
            (s.loadNumber ? String(s.loadNumber).replace(/^GL/i, "INV-") : `INV-${Date.now()}`);

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                invoiceNumber,
                invoiceDate,
                invoiceDueDate: dueDate,
                paymentStatus: s.paymentStatus || "INVOICED",
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CUSTOMER_INVOICE_GENERATED",
            title: "Customer invoice recorded",
            message: `Invoice ${invoiceNumber}`,
            actorUserId: actor.userId,
            payload: { invoiceNumber },
        });
        await writeAudit({
            actor,
            action: "INVOICE_CREATED",
            shipmentLeadId,
            newValue: { invoiceNumber, invoiceDate, dueDate },
        });
        return updated;
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
        const absolutePath = path.join(LOAD_DOCS_ROOT, shipmentLeadId, invoiceDoc.storedName);
        if (!fs.existsSync(absolutePath)) {
            throw badRequest("Customer Invoice file is missing on the server");
        }

        const to = String(s.customerEmail || "").trim();
        if (!to || !to.includes("@")) {
            throw badRequest(
                "Customer email is missing on this load. Add the customer email, then send again."
            );
        }

        const payment = customerPaymentQuote({
            customerRate: s.customerRate,
            accessorialCharges: s.accessorialCharges,
            method: s.customerPaymentMethod,
            waiveFee: s.waiveCustomerPaymentFee,
        });
        const invoiceNumber =
            String(s.invoiceNumber || "").trim() ||
            (s.loadNumber ? String(s.loadNumber).replace(/^GL/i, "INV-") : `INV-${Date.now()}`);
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
            },
        });
        await writeAudit({
            actor,
            action: "INVOICE_SENT",
            shipmentLeadId,
            oldValue: { paymentStatus: s.paymentStatus, invoiceNumber: s.invoiceNumber },
            newValue: {
                paymentStatus: updated.paymentStatus,
                invoiceNumber,
                emailTo: to,
                from: mail.from,
            },
        });
        return {
            ...updated,
            emailTo: to,
            emailFrom: mail.from,
            invoiceNumber,
            documentId: invoiceDoc.documentId,
        };
    }

    async recordCustomerPayment(actor: Actor, shipmentLeadId: string) {
        assertPerm(actor, AccountingPermissions.CustomerPaymentsRecord);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (!s.accountingReadyForBilling && !s.invoiceNumber) {
            throw badRequest("Shipment must be Ready for Billing before recording payment");
        }
        const now = new Date();
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                customerPaidAt: now,
                customerPaidById: actor.userId,
                paymentStatus: "CUSTOMER_PAID",
                paymentDate: now,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CUSTOMER_PAYMENT_RECEIVED",
            title: "Customer Paid",
            message: "Accounting Payments recorded customer payment",
            actorUserId: actor.userId,
            payload: { paidAt: now.toISOString() },
        });
        await writeAudit({
            actor,
            action: "CUSTOMER_PAYMENT_RECORDED",
            shipmentLeadId,
            newValue: { customerPaidAt: now.toISOString() },
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

        if (s.accountingDocStatus !== AccountingDocStatus.Verified) {
            throw forbid(
                "Carrier payment blocked — Accounting Documents verification incomplete",
                "CARRIER_PAYMENT_BLOCKED"
            );
        }
        if (!s.accountingFinancialVerified) {
            throw forbid(
                "Carrier payment blocked — financial amounts not verified",
                "CARRIER_PAYMENT_BLOCKED"
            );
        }
        if (!s.accountingReadyForCarrierPayment) {
            throw forbid(
                "Carrier payment blocked — shipment is not Ready for Carrier Payment",
                "CARRIER_PAYMENT_BLOCKED"
            );
        }
        if (s.carrierPaidAt) {
            throw badRequest("Carrier already marked paid");
        }

        const now = new Date();
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                carrierPaidAt: now,
                carrierPaidById: actor.userId,
                paymentStatus: "CUSTOMER_AND_CARRIER_PAID",
                accountingNotes: note
                    ? [s.accountingNotes, `CARRIER PAYMENT: ${note}`].filter(Boolean).join("\n")
                    : s.accountingNotes,
                accountingClosedAt: s.customerPaidAt ? now : s.accountingClosedAt,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CARRIER_PAID",
            title: "Carrier Paid",
            message: "Accounting Payments executed carrier payment",
            actorUserId: actor.userId,
            payload: { paidAt: now.toISOString() },
        });
        await writeAudit({
            actor,
            action: "CARRIER_PAYMENT_EXECUTED",
            shipmentLeadId,
            newValue: { carrierPaidAt: now.toISOString() },
            reason: note || null,
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

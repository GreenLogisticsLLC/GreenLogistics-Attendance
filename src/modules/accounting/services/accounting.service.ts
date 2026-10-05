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
                status: {
                    in: [
                        "DELIVERED",
                        "POD_UPLOADED",
                        "CUSTOMER_INVOICE",
                        "CARRIER_PAYMENT",
                        "CLOSED",
                        "IN_TRANSIT",
                        "PICKUP",
                        "CARRIER_ACCEPTED",
                        "RATE_CON_GENERATED",
                    ],
                },
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
                invoiceDueDate: true,
                accountingClosedAt: true,
                paymentStatus: true,
            },
        });

        const now = Date.now();
        const docsPending = rows.filter(
            (r) =>
                !r.accountingDocStatus ||
                r.accountingDocStatus === AccountingDocStatus.Pending ||
                r.accountingDocStatus === AccountingDocStatus.NeedsCorrection
        ).length;
        const needsCorrection = rows.filter(
            (r) => r.accountingDocStatus === AccountingDocStatus.NeedsCorrection
        ).length;
        const readyBilling = rows.filter(
            (r) => r.accountingReadyForBilling && !r.invoiceNumber && !r.customerPaidAt
        ).length;
        const invoicesOutstanding = rows.filter(
            (r) => r.invoiceNumber && !r.customerPaidAt
        ).length;
        const customerPaid = rows.filter((r) => Boolean(r.customerPaidAt)).length;
        const readyCarrierPay = rows.filter(
            (r) => r.accountingReadyForCarrierPayment && !r.carrierPaidAt
        ).length;
        const carrierPaid = rows.filter((r) => Boolean(r.carrierPaidAt)).length;
        const overdue = rows.filter((r) => {
            if (!r.invoiceDueDate || r.customerPaidAt) return false;
            return new Date(r.invoiceDueDate).getTime() < now;
        }).length;
        const closed = rows.filter((r) => Boolean(r.accountingClosedAt)).length;

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
        };
    }

    async listShipments(actor: Actor, filter?: string) {
        assertPerm(actor, AccountingPermissions.ShipmentsView);
        const f = String(filter || "all").toLowerCase();
        const rows = await prisma.shipmentLead.findMany({
            where: { loadNumber: { not: null } },
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
                deliveryCity: true,
                deliveryState: true,
                customerRate: true,
                carrierRate: true,
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

        let list = rows.map((r) => ({
            ...r,
            brokerName: r.assignedBrokerId
                ? brokerName.get(r.assignedBrokerId) || "—"
                : "—",
            customerTotal:
                (money(r.customerRate) || 0) + (money(r.accessorialCharges) || 0) || null,
            carrierTotal: money(r.carrierRate),
            outstandingCustomer:
                r.customerPaidAt
                    ? 0
                    : (money(r.customerRate) || 0) + (money(r.accessorialCharges) || 0),
            outstandingCarrier: r.carrierPaidAt ? 0 : money(r.carrierRate) || 0,
        }));

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
                        version: true,
                        createdAt: true,
                    },
                    orderBy: { createdAt: "desc" },
                },
            },
        });
        if (!s) throw notFound("Shipment not found");

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

        const customerTotal =
            (money(s.customerRate) || 0) + (money(s.accessorialCharges) || 0);
        const carrierTotal = money(s.carrierRate) || 0;

        return {
            identity: {
                shipmentLeadId: s.shipmentLeadId,
                loadNumber: s.loadNumber,
                greenOsShipmentId: s.greenOsShipmentId,
                status: s.status,
                brokerName,
            },
            lane: {
                pickup: [s.pickupCity, s.pickupState, s.pickupZip].filter(Boolean).join(", "),
                delivery: [s.deliveryCity, s.deliveryState, s.deliveryZip]
                    .filter(Boolean)
                    .join(", "),
            },
            customer: {
                name: s.customerName,
                rate: money(s.customerRate),
                accessorials: money(s.accessorialCharges),
                total: customerTotal,
                invoiceNumber: s.invoiceNumber,
                invoiceDate: s.invoiceDate,
                dueDate: s.invoiceDueDate,
                amountReceived: s.customerPaidAt ? customerTotal : 0,
                outstanding: s.customerPaidAt ? 0 : customerTotal,
                paymentStatus: s.paymentStatus,
                paidAt: s.customerPaidAt,
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
            },
            documents: s.loadDocuments,
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
        if (!s.invoiceNumber) {
            throw badRequest("Create an invoice before sending");
        }
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                paymentStatus:
                    s.paymentStatus === "CUSTOMER_PAID" ||
                    s.paymentStatus === "CUSTOMER_AND_CARRIER_PAID"
                        ? s.paymentStatus
                        : "INVOICE_SENT",
            },
        });
        await writeAudit({
            actor,
            action: "INVOICE_SENT",
            shipmentLeadId,
            oldValue: { paymentStatus: s.paymentStatus },
            newValue: { paymentStatus: updated.paymentStatus, invoiceNumber: s.invoiceNumber },
        });
        return updated;
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

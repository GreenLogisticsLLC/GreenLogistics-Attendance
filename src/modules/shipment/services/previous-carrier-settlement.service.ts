import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { LOAD_DOCS_ROOT } from "./load-pdf.service.js";
import {
    buildSettlementHistoryKey,
    normalizeSettlementStatus,
    settlementsVisibleToAccounting,
    statusAfterInvoiceUpload,
    sumPayablePreviousCarrierExpenses,
} from "../previous-carrier-settlement.js";
import { parseCarrierHistory } from "../carrier-history.js";

function money(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function badRequest(message: string, status = 400) {
    return Object.assign(new Error(message), { status });
}

export type CreatePreviousCarrierSettlementInput = {
    shipmentLeadId: string;
    loadNumber?: string | null;
    previousCarrierId?: string | null;
    carrierName?: string | null;
    carrierEmail?: string | null;
    carrierMc?: string | null;
    carrierDot?: string | null;
    paymentAmount?: number | null;
    paymentReason?: string | null;
    replacedAt?: string | null;
    actorUserId?: string | null;
};

export const previousCarrierSettlementService = {
    async createFromCarrierChange(input: CreatePreviousCarrierSettlementInput) {
        const paymentAmount = money(input.paymentAmount);
        const replacedAt = input.replacedAt || new Date().toISOString();
        const historyKey = buildSettlementHistoryKey({
            replacedAt,
            carrierEmail: input.carrierEmail,
            carrierProfileId: input.previousCarrierId,
            carrierName: input.carrierName,
        });
        const carrierAssignmentId = crypto.randomUUID();
        const status = normalizeSettlementStatus(null, paymentAmount);

        const existing = await prisma.previousCarrierSettlement.findUnique({
            where: {
                shipmentLeadId_historyKey: {
                    shipmentLeadId: input.shipmentLeadId,
                    historyKey,
                },
            },
        });
        if (existing) return existing;

        const row = await prisma.previousCarrierSettlement.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                loadNumber: input.loadNumber || null,
                carrierAssignmentId,
                previousCarrierId: input.previousCarrierId || null,
                carrierName: input.carrierName || null,
                carrierEmail: input.carrierEmail || null,
                carrierMc: input.carrierMc || null,
                carrierDot: input.carrierDot || null,
                paymentAmount,
                paymentReason: input.paymentReason
                    ? String(input.paymentReason).trim() || null
                    : null,
                status,
                historyKey,
            },
        });

        await domainEventEngine
            .emit({
                shipmentLeadId: input.shipmentLeadId,
                eventType: "PREVIOUS_CARRIER_SETTLEMENT_CREATED",
                title: "Previous carrier settlement",
                message: `${row.carrierName || "Previous carrier"}: $${paymentAmount.toFixed(2)} (${status})`,
                actorUserId: input.actorUserId || undefined,
                payload: {
                    settlementId: row.settlementId,
                    paymentAmount,
                    status,
                    carrierAssignmentId,
                    previousCarrierId: row.previousCarrierId,
                },
            })
            .catch(() => undefined);

        return row;
    },

    /**
     * Ensure legacy carrierHistoryJson rows have settlement records (idempotent).
     * paymentAmount defaults to archived carrierRate.
     */
    async ensureFromCarrierHistory(shipmentLeadId: string) {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                carrierHistoryJson: true,
            },
        });
        if (!lead) return [];
        const history = parseCarrierHistory(lead.carrierHistoryJson);
        for (const entry of history) {
            const historyKey = buildSettlementHistoryKey({
                replacedAt: entry.replacedAt,
                carrierEmail: entry.carrierEmail,
                carrierProfileId: entry.carrierProfileId,
                carrierName: entry.carrierName,
            });
            const exists = await prisma.previousCarrierSettlement.findUnique({
                where: {
                    shipmentLeadId_historyKey: {
                        shipmentLeadId,
                        historyKey,
                    },
                },
            });
            if (exists) continue;
            const paymentAmount = money(entry.carrierRate);
            await prisma.previousCarrierSettlement.create({
                data: {
                    shipmentLeadId,
                    loadNumber: lead.loadNumber,
                    carrierAssignmentId: crypto.randomUUID(),
                    previousCarrierId: entry.carrierProfileId,
                    carrierName: entry.carrierName,
                    carrierEmail: entry.carrierEmail,
                    carrierMc: entry.carrierMc,
                    carrierDot: entry.carrierDot,
                    paymentAmount,
                    paymentReason: entry.reason || "carrier_change",
                    status: normalizeSettlementStatus(null, paymentAmount),
                    historyKey,
                },
            });
        }
        return this.listForLoad(shipmentLeadId);
    },

    async listForLoad(shipmentLeadId: string) {
        return prisma.previousCarrierSettlement.findMany({
            where: { shipmentLeadId },
            orderBy: { createdAt: "asc" },
        });
    },

    async listForAccounting(shipmentLeadId: string) {
        await this.ensureFromCarrierHistory(shipmentLeadId);
        const rows = await this.listForLoad(shipmentLeadId);
        return settlementsVisibleToAccounting(rows);
    },

    async sumPayableForLoad(shipmentLeadId: string): Promise<number> {
        await this.ensureFromCarrierHistory(shipmentLeadId);
        const rows = await this.listForLoad(shipmentLeadId);
        return sumPayablePreviousCarrierExpenses(rows);
    },

    async approve(
        actor: { userId: string },
        settlementId: string,
        note?: string
    ) {
        const row = await prisma.previousCarrierSettlement.findUnique({
            where: { settlementId },
        });
        if (!row) throw badRequest("Previous carrier settlement not found", 404);
        if (money(row.paymentAmount) <= 0) {
            throw badRequest("Nothing to approve for $0 settlements");
        }
        if (row.status === "PAID") return row;
        if (row.status === "REJECTED") {
            throw badRequest("Rejected settlement cannot be approved — create a new change if needed");
        }
        const now = new Date();
        const nextStatus =
            row.status === "INVOICE_UPLOADED" || row.status === "PAID"
                ? row.status
                : "APPROVED";
        const updated = await prisma.previousCarrierSettlement.update({
            where: { settlementId },
            data: {
                status: nextStatus,
                reviewedAt: now,
                reviewedById: actor.userId,
                accountingDecisionNote: note
                    ? String(note).trim() || null
                    : row.accountingDecisionNote || "Approved",
                rejectionComment: null,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId: row.shipmentLeadId,
            eventType: "PREVIOUS_CARRIER_SETTLEMENT_APPROVED",
            title: "Previous carrier settlement approved",
            message: `${row.carrierName || "Previous carrier"} settlement approved`,
            actorUserId: actor.userId,
            payload: {
                settlementId,
                note: note || null,
                status: updated.status,
            },
        });
        return updated;
    },

    async reject(
        actor: { userId: string },
        settlementId: string,
        comment: string
    ) {
        const row = await prisma.previousCarrierSettlement.findUnique({
            where: { settlementId },
        });
        if (!row) throw badRequest("Previous carrier settlement not found", 404);
        if (row.status === "PAID") {
            throw badRequest("Paid settlements cannot be rejected");
        }
        const reason = String(comment || "").trim();
        if (!reason) throw badRequest("Rejection comment is required");
        const now = new Date();
        const updated = await prisma.previousCarrierSettlement.update({
            where: { settlementId },
            data: {
                status: "REJECTED",
                reviewedAt: now,
                reviewedById: actor.userId,
                rejectionComment: reason,
                accountingDecisionNote: reason,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId: row.shipmentLeadId,
            eventType: "PREVIOUS_CARRIER_SETTLEMENT_REJECTED",
            title: "Previous carrier settlement rejected",
            message: `${row.carrierName || "Previous carrier"} settlement rejected`,
            actorUserId: actor.userId,
            payload: {
                settlementId,
                rejectionComment: reason,
            },
        });
        return updated;
    },

    async listQueue(status?: string | null) {
        const where: Record<string, unknown> = {
            paymentAmount: { gt: 0 },
        };
        if (status) {
            where.status = String(status).toUpperCase();
        } else {
            where.status = { in: ["PENDING_ACCOUNTING", "APPROVED", "INVOICE_UPLOADED"] };
        }
        return prisma.previousCarrierSettlement.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: 200,
        });
    },

    async updatePaymentDetails(
        actor: { userId: string },
        settlementId: string,
        body: { paymentMethod?: unknown; paymentDate?: unknown }
    ) {
        const {
            normalizeAccountingCarrierPaymentMethod,
            parseAccountingPaymentDate,
        } = await import("../carrier-payment-method.js");
        const row = await prisma.previousCarrierSettlement.findUnique({
            where: { settlementId },
        });
        if (!row) throw badRequest("Previous carrier settlement not found", 404);
        const data: Record<string, unknown> = {};
        if (body.paymentMethod !== undefined) {
            if (body.paymentMethod == null || body.paymentMethod === "") {
                data.paymentMethod = null;
            } else {
                const method = normalizeAccountingCarrierPaymentMethod(body.paymentMethod);
                if (!method) {
                    throw badRequest(
                        "Carrier payment method must be Zelle, PayPal, Venmo, Stripe, Factoring Company, or ACH"
                    );
                }
                data.paymentMethod = method;
            }
        }
        if (body.paymentDate !== undefined) {
            if (body.paymentDate == null || body.paymentDate === "") {
                // Clearing the date does not un-pay a PAID settlement — paidAt stays.
                // Only clear when not yet marked paid.
                if (row.status !== "PAID") data.paidAt = null;
            } else {
                const d = parseAccountingPaymentDate(body.paymentDate);
                if (!d) throw badRequest("Payment date is invalid");
                data.paidAt = d;
            }
        }
        if (!Object.keys(data).length) {
            throw badRequest("No settlement payment details to save");
        }
        return prisma.previousCarrierSettlement.update({
            where: { settlementId },
            data: data as {
                paymentMethod?: string | null;
                paidAt?: Date | null;
            },
        });
    },

    async markPaid(
        actor: { userId: string },
        settlementId: string,
        note?: string,
        details?: { paymentMethod?: unknown; paymentDate?: unknown }
    ) {
        const {
            normalizeAccountingCarrierPaymentMethod,
            parseAccountingPaymentDate,
        } = await import("../carrier-payment-method.js");
        const row = await prisma.previousCarrierSettlement.findUnique({
            where: { settlementId },
        });
        if (!row) throw badRequest("Previous carrier settlement not found", 404);
        if (money(row.paymentAmount) <= 0) {
            throw badRequest("Settlement has no payment amount");
        }
        if (row.status === "REJECTED") {
            throw badRequest("Rejected settlements cannot be marked paid");
        }

        const data: {
            status: string;
            paidById: string;
            paymentMethod?: string;
            paidAt?: Date;
        } = {
            status: "PAID",
            paidById: actor.userId,
        };
        if (details?.paymentMethod !== undefined && details.paymentMethod !== "") {
            const method = normalizeAccountingCarrierPaymentMethod(details.paymentMethod);
            if (!method) {
                throw badRequest(
                    "Carrier payment method must be Zelle, PayPal, Venmo, Stripe, Factoring Company, or ACH"
                );
            }
            data.paymentMethod = method;
        }
        if (details?.paymentDate !== undefined && details.paymentDate !== "") {
            const d = parseAccountingPaymentDate(details.paymentDate);
            if (!d) throw badRequest("Payment date is invalid");
            data.paidAt = d;
        } else if (!row.paidAt) {
            data.paidAt = new Date();
        }

        const alreadyPaid = row.status === "PAID" && Boolean(row.paidAt);
        const updated = await prisma.previousCarrierSettlement.update({
            where: { settlementId },
            data,
        });
        if (!alreadyPaid) {
            await domainEventEngine.emit({
                shipmentLeadId: row.shipmentLeadId,
                eventType: "PREVIOUS_CARRIER_SETTLEMENT_PAID",
                title: "Previous carrier marked paid",
                message: `${row.carrierName || "Previous carrier"} settlement marked PAID`,
                actorUserId: actor.userId,
                payload: {
                    settlementId,
                    paidAt: updated.paidAt?.toISOString() || null,
                    paymentMethod: updated.paymentMethod,
                    note: note || null,
                    paymentAmount: row.paymentAmount,
                },
            });
        }
        return updated;
    },

    async uploadInvoice(input: {
        settlementId: string;
        actorUserId: string;
        originalName: string;
        mimeType: string;
        tempPath: string;
    }) {
        const row = await prisma.previousCarrierSettlement.findUnique({
            where: { settlementId: input.settlementId },
        });
        if (!row) throw badRequest("Previous carrier settlement not found", 404);
        if (money(row.paymentAmount) <= 0) {
            throw badRequest("No invoice required for $0 settlements");
        }
        if (!input.tempPath || !fs.existsSync(input.tempPath)) {
            throw badRequest("Uploaded file is missing");
        }

        const docType = "ATTACHMENT";
        const last = await prisma.loadDocument.findFirst({
            where: { shipmentLeadId: row.shipmentLeadId, docType },
            orderBy: { version: "desc" },
        });
        const version = (last?.version || 0) + 1;
        const ext = path.extname(input.originalName || "").toLowerCase() || ".bin";
        const storedName = `PREV_CARRIER_INV_${row.settlementId.slice(0, 8)}_v${version}_${Date.now()}${ext}`;
        const dir = path.join(LOAD_DOCS_ROOT, row.shipmentLeadId);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, storedName);
        fs.copyFileSync(input.tempPath, dest);
        try {
            fs.unlinkSync(input.tempPath);
        } catch {
            /* ignore */
        }
        const stat = fs.statSync(dest);
        const fileName = path.basename(input.originalName || storedName);
        const contentJson = JSON.stringify({
            kind: "PREVIOUS_CARRIER_INVOICE",
            settlementId: row.settlementId,
            carrierAssignmentId: row.carrierAssignmentId,
            previousCarrierId: row.previousCarrierId,
            loadNumber: row.loadNumber,
        });

        const doc = await prisma.loadDocument.create({
            data: {
                shipmentLeadId: row.shipmentLeadId,
                docType,
                version,
                changeReason: "UPLOADED",
                title: `Previous carrier invoice — ${row.carrierName || fileName}`,
                status: "READY",
                isCurrent: true,
                contentJson,
                fileName,
                mimeType: input.mimeType || "application/octet-stream",
                storedName,
                fileUrl: `/api/loads/${row.shipmentLeadId}/documents/file/${storedName}`,
                fileSize: stat.size,
                createdById: input.actorUserId,
            },
        });

        const nextStatus = statusAfterInvoiceUpload(row.status, row.paymentAmount);
        const updated = await prisma.previousCarrierSettlement.update({
            where: { settlementId: row.settlementId },
            data: {
                invoiceDocumentId: doc.documentId,
                status: nextStatus,
            },
        });

        await domainEventEngine
            .emit({
                shipmentLeadId: row.shipmentLeadId,
                eventType: "PREVIOUS_CARRIER_INVOICE_UPLOADED",
                title: "Previous carrier invoice uploaded",
                message: `Invoice for ${row.carrierName || "previous carrier"} saved (status ${nextStatus})`,
                actorUserId: input.actorUserId,
                payload: {
                    settlementId: row.settlementId,
                    documentId: doc.documentId,
                    status: nextStatus,
                },
            })
            .catch(() => undefined);

        return { settlement: updated, document: doc };
    },
};

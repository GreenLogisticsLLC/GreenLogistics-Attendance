import { prisma } from "../../../config/database.js";
import { Roles } from "../../../auth/roles.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { AccountingDocStatus } from "../../accounting/accounting.constants.js";
import { appendCarrierHistory } from "../carrier-history.js";
import {
    CARRIER_CHANGE_LOAD_STATUS,
    changeReasonLabel,
    paymentReasonLabel,
    previousStatusLabel,
    validateCarrierChangePreviousInfo,
    type CarrierChangePreviousInfoInput,
} from "../carrier-change.js";
import { buildSettlementHistoryKey, normalizeSettlementStatus } from "../previous-carrier-settlement.js";

function badRequest(message: string, status = 422, code = "CARRIER_CHANGE_INVALID") {
    return Object.assign(new Error(message), { status, code });
}

function forbid(message: string) {
    return Object.assign(new Error(message), { status: 403, code: "CARRIER_CHANGE_FORBIDDEN" });
}

function canStartCarrierChange(role: string | undefined) {
    return [
        Roles.Owner,
        Roles.Administrator,
        Roles.Manager,
        Roles.TeamLead,
        Roles.Broker,
    ].includes(String(role || "") as never);
}

export const carrierChangeService = {
    async ensureActiveAssignment(shipmentLeadId: string) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) throw badRequest("Load not found", 404, "NOT_FOUND");
        if (!lead.carrierName && !lead.carrierEmail && !lead.carrierProfileId) {
            return null;
        }
        if (lead.activeCarrierAssignmentId) {
            const existing = await prisma.loadCarrierAssignment.findUnique({
                where: { assignmentId: lead.activeCarrierAssignmentId },
            });
            if (existing && existing.status === "ACTIVE") return existing;
        }
        const active = await prisma.loadCarrierAssignment.findFirst({
            where: { shipmentLeadId, status: "ACTIVE" },
            orderBy: { startedAt: "desc" },
        });
        if (active) {
            if (lead.activeCarrierAssignmentId !== active.assignmentId) {
                await prisma.shipmentLead.update({
                    where: { shipmentLeadId },
                    data: { activeCarrierAssignmentId: active.assignmentId },
                });
            }
            return active;
        }
        const created = await prisma.loadCarrierAssignment.create({
            data: {
                shipmentLeadId,
                loadNumber: lead.loadNumber,
                carrierProfileId: lead.carrierProfileId,
                carrierName: lead.carrierName,
                carrierEmail: lead.carrierEmail,
                carrierPhone: lead.carrierPhone,
                carrierMc: lead.carrierMc,
                carrierDot: lead.carrierDot,
                carrierRate: lead.carrierRate,
                status: "ACTIVE",
            },
        });
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { activeCarrierAssignmentId: created.assignmentId },
        });
        return created;
    },

    async getPreviousCarrierPrefill(shipmentLeadId: string) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) throw badRequest("Load not found", 404, "NOT_FOUND");
        const assignment = await this.ensureActiveAssignment(shipmentLeadId);
        return {
            loadNumber: lead.loadNumber,
            shipmentLeadId,
            carrierChangeStatus: lead.carrierChangeStatus,
            previousCarrier: {
                companyName: lead.carrierName,
                carrierEmail: lead.carrierEmail,
                mcNumber: lead.carrierMc,
                dotNumber: lead.carrierDot,
                carrierProfileId: lead.carrierProfileId,
                carrierRate: lead.carrierRate,
                assignmentId: assignment?.assignmentId || lead.activeCarrierAssignmentId || null,
            },
            enums: {
                changeReasons: (
                    await import("../carrier-change.js")
                ).CARRIER_CHANGE_REASONS.map((id) => ({
                    id,
                    label: changeReasonLabel(id),
                })),
                previousCarrierStatuses: (
                    await import("../carrier-change.js")
                ).PREVIOUS_CARRIER_STATUSES.map((id) => ({
                    id,
                    label: previousStatusLabel(id),
                })),
                paymentReasons: (
                    await import("../carrier-change.js")
                ).PREVIOUS_PAYMENT_REASONS.map((id) => ({
                    id,
                    label: paymentReasonLabel(id),
                })),
            },
        };
    },

    /**
     * Save Previous Carrier Information, archive assignment, create settlement,
     * set REPLACEMENT_IN_PROGRESS. Does not create a new Load.
     */
    async startCarrierChange(
        shipmentLeadId: string,
        body: CarrierChangePreviousInfoInput,
        actor: { userId: string; role?: string }
    ) {
        if (!canStartCarrierChange(actor.role)) {
            throw forbid("You cannot start Carrier Change");
        }
        const info = validateCarrierChangePreviousInfo(body);
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) throw badRequest("Load not found", 404, "NOT_FOUND");
        if (!lead.loadNumber) {
            throw badRequest("Create Load first before Carrier Change");
        }
        if (!lead.carrierName) {
            throw badRequest("Assign a carrier before starting Carrier Change");
        }
        if (lead.carrierChangeStatus === CARRIER_CHANGE_LOAD_STATUS.ReplacementInProgress) {
            throw badRequest(
                "Carrier Change already in progress — finish registering the new carrier first"
            );
        }

        const assignment = await this.ensureActiveAssignment(shipmentLeadId);
        if (!assignment) throw badRequest("No active carrier assignment to replace");

        const replacedAt = new Date();
        const historyKey = buildSettlementHistoryKey({
            replacedAt: replacedAt.toISOString(),
            carrierEmail: lead.carrierEmail,
            carrierProfileId: lead.carrierProfileId,
            carrierName: lead.carrierName,
        });

        const existingSettlement = await prisma.previousCarrierSettlement.findUnique({
            where: {
                shipmentLeadId_historyKey: {
                    shipmentLeadId,
                    historyKey,
                },
            },
        });
        if (existingSettlement) {
            throw badRequest("Duplicate settlement request for this carrier change");
        }

        const settlementStatus = normalizeSettlementStatus(null, info.paymentAmount);
        const historyJson = appendCarrierHistory(lead.carrierHistoryJson, {
            carrierName: lead.carrierName,
            carrierEmail: lead.carrierEmail,
            carrierPhone: lead.carrierPhone,
            carrierMc: lead.carrierMc,
            carrierDot: lead.carrierDot,
            carrierProfileId: lead.carrierProfileId,
            carrierRate: info.paymentAmount,
            reason: info.changeReason,
            replacedAt: replacedAt.toISOString(),
        });

        const result = await prisma.$transaction(async (tx) => {
            const settlement = await tx.previousCarrierSettlement.create({
                data: {
                    shipmentLeadId,
                    loadNumber: lead.loadNumber,
                    carrierAssignmentId: assignment.assignmentId,
                    previousCarrierId: lead.carrierProfileId,
                    carrierName: lead.carrierName,
                    carrierEmail: lead.carrierEmail,
                    carrierMc: lead.carrierMc,
                    carrierDot: lead.carrierDot,
                    paymentAmount: info.paymentAmount,
                    paymentReason: paymentReasonLabel(info.paymentReason),
                    paymentReasonCode: info.paymentReason,
                    changeReason: info.changeReason,
                    previousCarrierStatus: info.previousCarrierStatus,
                    brokerId: actor.userId,
                    brokerComment: info.brokerComment,
                    status: settlementStatus,
                    historyKey,
                },
            });

            await tx.loadCarrierAssignment.update({
                where: { assignmentId: assignment.assignmentId },
                data: {
                    status: "REPLACED",
                    endedAt: replacedAt,
                    changeReason: info.changeReason,
                    previousCarrierStatus: info.previousCarrierStatus,
                    replacedByBrokerId: actor.userId,
                    settlementId: settlement.settlementId,
                    carrierRate:
                        assignment.carrierRate != null
                            ? assignment.carrierRate
                            : lead.carrierRate,
                },
            });

            await tx.shipmentLead.update({
                where: { shipmentLeadId },
                data: {
                    carrierHistoryJson: historyJson,
                    carrierChangeStatus: CARRIER_CHANGE_LOAD_STATUS.ReplacementInProgress,
                    activeCarrierAssignmentId: null,
                    // Clear operational carrier fields so broker registers the replacement
                    // via the existing Carrier form — same Load Number.
                    carrierName: null,
                    carrierEmail: null,
                    carrierPhone: null,
                    carrierMc: null,
                    carrierDot: null,
                    carrierInsurance: null,
                    carrierProfileId: null,
                    carrierRate: null,
                    driverName: null,
                    driverPhone: null,
                    truckNumber: null,
                    trailerNumber: null,
                    trailerVin: null,
                    loadCarrierApprovedAt: null,
                    loadCarrierApprovedById: null,
                    loadCarrierApprovedProfileId: null,
                    accountingDocStatus: AccountingDocStatus.Pending,
                    accountingDocVerifiedAt: null,
                    accountingDocVerifiedById: null,
                    accountingFinancialVerified: false,
                    accountingReadyForBilling: false,
                    accountingReadyForCarrierPayment: false,
                    accountingReactivatedAt: replacedAt,
                    status: "CARRIER_ASSIGNED",
                },
            });

            return settlement;
        });

        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CARRIER_CHANGE_STARTED",
            title: "Carrier Change started",
            message: `Previous carrier ${lead.carrierName || "—"} archived. Settlement ${result.status} ($${info.paymentAmount.toFixed(2)}). Register the new carrier on this Load Number.`,
            actorUserId: actor.userId,
            payload: {
                previousCarrierName: lead.carrierName,
                previousCarrierEmail: lead.carrierEmail,
                previousAssignmentId: assignment.assignmentId,
                settlementId: result.settlementId,
                changeReason: info.changeReason,
                previousCarrierStatus: info.previousCarrierStatus,
                paymentAmount: info.paymentAmount,
                paymentReason: info.paymentReason,
                brokerComment: info.brokerComment,
                status: result.status,
            },
            timelineStage: "CARRIER_ASSIGNED",
        });

        return {
            shipmentLeadId,
            loadNumber: lead.loadNumber,
            carrierChangeStatus: CARRIER_CHANGE_LOAD_STATUS.ReplacementInProgress,
            previousAssignmentId: assignment.assignmentId,
            settlement: result,
            nextStep:
                "Use the existing Register carrier form on this Load to add the replacement carrier. Compliance / documents / Approve Carrier stay unchanged.",
        };
    },

    /**
     * After broker saves a new carrier while REPLACEMENT_IN_PROGRESS — activate assignment.
     */
    async activateReplacementAssignment(
        shipmentLeadId: string,
        actorUserId?: string | null
    ) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) return null;
        if (lead.carrierChangeStatus !== CARRIER_CHANGE_LOAD_STATUS.ReplacementInProgress) {
            // Still ensure an active assignment exists for normal assigns.
            if (lead.carrierName) await this.ensureActiveAssignment(shipmentLeadId);
            return null;
        }
        if (!lead.carrierName) return null;

        const created = await prisma.loadCarrierAssignment.create({
            data: {
                shipmentLeadId,
                loadNumber: lead.loadNumber,
                carrierProfileId: lead.carrierProfileId,
                carrierName: lead.carrierName,
                carrierEmail: lead.carrierEmail,
                carrierPhone: lead.carrierPhone,
                carrierMc: lead.carrierMc,
                carrierDot: lead.carrierDot,
                carrierRate: lead.carrierRate,
                status: "ACTIVE",
            },
        });
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                activeCarrierAssignmentId: created.assignmentId,
                carrierChangeStatus: null,
            },
        });
        await domainEventEngine
            .emit({
                shipmentLeadId,
                eventType: "CARRIER_CHANGE_COMPLETED",
                title: "Replacement carrier activated",
                message: `${lead.carrierName} is now the current carrier on ${lead.loadNumber || "this Load"}.`,
                actorUserId: actorUserId || undefined,
                payload: {
                    assignmentId: created.assignmentId,
                    carrierName: lead.carrierName,
                    carrierEmail: lead.carrierEmail,
                    carrierProfileId: lead.carrierProfileId,
                },
                timelineStage: "CARRIER_ASSIGNED",
            })
            .catch(() => undefined);
        return created;
    },

    async listAssignments(shipmentLeadId: string) {
        await this.ensureActiveAssignment(shipmentLeadId).catch(() => null);
        const rows = await prisma.loadCarrierAssignment.findMany({
            where: { shipmentLeadId },
            orderBy: { startedAt: "asc" },
        });
        const settlements = await prisma.previousCarrierSettlement.findMany({
            where: { shipmentLeadId },
        });
        const byAssignment = new Map(
            settlements.map((s) => [s.carrierAssignmentId, s] as const)
        );
        const docs = await prisma.loadDocument.findMany({
            where: {
                shipmentLeadId,
                isCurrent: true,
                carrierAssignmentId: { not: null },
            },
            select: {
                documentId: true,
                docType: true,
                title: true,
                status: true,
                fileUrl: true,
                fileName: true,
                carrierAssignmentId: true,
                createdAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
        const docsByAssignment = new Map<string, typeof docs>();
        for (const d of docs) {
            const key = String(d.carrierAssignmentId || "");
            if (!key) continue;
            const list = docsByAssignment.get(key) || [];
            list.push(d);
            docsByAssignment.set(key, list);
        }

        return rows.map((a) => {
            const settlement = byAssignment.get(a.assignmentId) || null;
            return {
                assignmentId: a.assignmentId,
                status: a.status,
                isCurrent: a.status === "ACTIVE",
                carrierName: a.carrierName,
                carrierEmail: a.carrierEmail,
                carrierMc: a.carrierMc,
                carrierDot: a.carrierDot,
                carrierProfileId: a.carrierProfileId,
                carrierRate: a.carrierRate,
                startedAt: a.startedAt,
                endedAt: a.endedAt,
                changeReason: a.changeReason,
                changeReasonLabel: changeReasonLabel(a.changeReason),
                previousCarrierStatus: a.previousCarrierStatus,
                previousCarrierStatusLabel: previousStatusLabel(a.previousCarrierStatus),
                replacedByBrokerId: a.replacedByBrokerId,
                settlement: settlement
                    ? {
                          settlementId: settlement.settlementId,
                          paymentAmount: settlement.paymentAmount,
                          paymentReason: settlement.paymentReason,
                          paymentReasonCode: settlement.paymentReasonCode,
                          status: settlement.status,
                          brokerComment: settlement.brokerComment,
                          paidAt: settlement.paidAt,
                          rejectionComment: settlement.rejectionComment,
                      }
                    : null,
                documents: docsByAssignment.get(a.assignmentId) || [],
            };
        });
    },
};

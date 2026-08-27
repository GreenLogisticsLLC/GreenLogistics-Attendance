import { prisma } from "../../../config/database.js";
import { assignmentEngine } from "../assignment.engine.js";
import { gmailListener } from "../../email/gmail/gmail.listener.js";
import { setCompanyImportAfter } from "../../email/services/gmail-import-cutoff.service.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import {
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "../../email/services/repositories.js";
import { sseEmitToUser } from "../../crm/services/realtime.hub.js";

/**
 * Admin ops: clean slate + refresh mailing distribution.
 * Keeps users, Gmail OAuth, attendance, carriers.
 */
export class AssignmentOpsService {
    /**
     * From this moment: ignore old unread Gmail, reclaim unworked leads,
     * redistribute parked NEW/UNASSIGNED to In Office brokers.
     */
    async refreshMailingDistribution(options?: {
        actorUserId?: string | null;
        drainLimit?: number;
        dismissUnread?: boolean;
    }) {
        const now = new Date();
        const importAfter = await setCompanyImportAfter(now, options?.actorUserId);
        let dismissedUnread = 0;
        if (options?.dismissUnread !== false) {
            dismissedUnread = await this.dismissCurrentUnread(80);
        }

        const reclaimed = await this.reclaimUnworkedLeads();
        await assignmentEngine.processDueAcceptances();
        const drained = await assignmentEngine.assignPendingNewLeads(
            options?.drainLimit ?? 100
        );
        const eligible = await assignmentEngine.listEligibleBrokers();

        await prisma.assignmentLog.create({
            data: {
                eventType: "ADMIN_REFRESH_MAILING",
                message: `Admin refresh: import_after=${importAfter.toISOString()}, dismissedUnread=${dismissedUnread}, reclaimed=${reclaimed}, drained=${drained}, eligible=${eligible.length}`,
                assignedUserId: options?.actorUserId || null,
                queueSnapshotJson: JSON.stringify({
                    importAfter: importAfter.toISOString(),
                    dismissedUnread,
                    reclaimed,
                    drained,
                    eligible: eligible.map((e) => e.displayName),
                }),
            },
        });

        return {
            importAfter: importAfter.toISOString(),
            dismissedUnread,
            reclaimed,
            drained,
            eligibleCount: eligible.length,
            eligible: eligible.map((e) => e.displayName),
        };
    }

    /**
     * Delete all shipment CRM rows and start mailing from now (clean slate).
     */
    async cleanSlateAllShipments(options?: { actorUserId?: string | null }) {
        const before = await prisma.shipmentLead.count();

        // Children without reliable cascade / loose FKs first
        await prisma.$executeRawUnsafe(`DELETE FROM shipment_import_logs`);
        await prisma.$executeRawUnsafe(`DELETE FROM shipment_timeline_events`);
        await prisma.$executeRawUnsafe(`DELETE FROM platform_notifications`);
        await prisma.$executeRawUnsafe(`DELETE FROM domain_events`);
        await prisma.$executeRawUnsafe(`DELETE FROM assignment_logs`);
        await prisma.$executeRawUnsafe(`DELETE FROM broker_mailbox_messages`);
        await prisma.$executeRawUnsafe(`DELETE FROM load_documents`);
        await prisma.$executeRawUnsafe(`DELETE FROM tracking_positions`);
        await prisma.$executeRawUnsafe(`DELETE FROM tracking_integration_events`);
        await prisma.$executeRawUnsafe(`DELETE FROM shipment_trackings`);
        try {
            await prisma.$executeRawUnsafe(`DELETE FROM ai_actions`);
        } catch {
            /* optional table */
        }
        try {
            await prisma.$executeRawUnsafe(
                `UPDATE carrier_onboarding_sessions SET shipment_lead_id = NULL`
            );
        } catch {
            /* optional */
        }

        await prisma.shipmentLead.deleteMany();
        await prisma.emailMessage.deleteMany();

        await prisma.assignmentQueueState.upsert({
            where: { queueKey: "brokers" },
            update: { orderedUserIdsJson: "[]", nextIndex: 0 },
            create: {
                queueKey: "brokers",
                orderedUserIdsJson: "[]",
                nextIndex: 0,
            },
        });

        const refresh = await this.refreshMailingDistribution({
            actorUserId: options?.actorUserId,
            drainLimit: 0,
            dismissUnread: true,
        });

        const after = await prisma.shipmentLead.count();
        return {
            deletedShipments: before,
            remainingShipments: after,
            ...refresh,
        };
    }

    /** Park every lead that was never accepted so Refresh can redistribute. */
    async reclaimUnworkedLeads(): Promise<number> {
        const leads = await prisma.shipmentLead.findMany({
            where: {
                acceptedAt: null,
                status: {
                    in: [
                        "NEW",
                        "UNASSIGNED",
                        "AWAITING_ACCEPTANCE",
                        "AGENT_OPEN",
                        "ASSIGNED",
                    ],
                },
                assignedBrokerId: { not: null },
            },
            take: 2000,
        });

        let n = 0;
        for (const lead of leads) {
            const previousBrokerId = lead.assignedBrokerId!;
            await shipmentLeadRepository.update(lead.shipmentLeadId, {
                status: "UNASSIGNED",
                assignedBrokerId: null,
                acceptanceDeadline: null,
            });
            await domainEventEngine.emit({
                shipmentLeadId: lead.shipmentLeadId,
                eventType: "SHIPMENT_UNASSIGNED",
                title: "Admin refresh — unworked lead reclaimed",
                message: "Not accepted / not worked — returned to In Office round-robin",
                timelineStage: "SHIPMENT_UNASSIGNED",
                payload: { previousBrokerId, reason: "ADMIN_REFRESH" },
            });
            sseEmitToUser(previousBrokerId, {
                type: "SHIPMENT_UNASSIGNED",
                shipmentLeadId: lead.shipmentLeadId,
                greenOsShipmentId: lead.greenOsShipmentId,
                shipmentTitle: lead.shipmentTitle,
                reason: "Admin refresh — removed from your queue",
                removedFromYourQueue: true,
                at: new Date().toISOString(),
            });
            n += 1;
        }
        return n;
    }

    /** Mark current unread company mail as read so old backlog stops importing. */
    async dismissCurrentUnread(maxMessages = 80): Promise<number> {
        if (!(await gmailListener.ensureCredentials())) return 0;
        const ids = await gmailListener.listUnreadMessageIds(maxMessages);
        let n = 0;
        for (const id of ids) {
            try {
                await gmailListener.markProcessed(id);
                await shipmentImportLogRepository.create({
                    eventType: "DismissedUnread",
                    message: `Admin dismissed unread Gmail (clean slate / refresh): ${id}`,
                    gmailMessageId: id,
                });
                n += 1;
            } catch (err) {
                console.warn("[assignment-ops] dismiss unread failed:", id, err);
            }
        }
        return n;
    }
}

export const assignmentOpsService = new AssignmentOpsService();

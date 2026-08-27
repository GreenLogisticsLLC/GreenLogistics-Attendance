import { sseEmitToRoles, sseEmitToUser } from "../modules/crm/services/realtime.hub.js";
import { platformNotificationService } from "../modules/shipment/services/platform-notification.service.js";
import { getBrokerTeamLeadId } from "../auth/team-scope.js";

const COMPANY_OPS_ROLES = ["Owner", "Manager", "Administrator"] as const;

/**
 * Notify company ops (Owner/Manager/Admin) + the assigned broker's Team Lead only.
 * Never broadcast to all Team Leads — each Team Lead only sees their own team.
 */
export async function notifyOpsAndOwningTeamLead(options: {
    assignedBrokerId: string | null | undefined;
    ssePayload: Record<string, unknown>;
    broadcastType?: string;
    notificationType: string;
    title: string;
    /** Optional title for the Team Lead only (defaults to title). */
    teamLeadTitle?: string;
    message: string;
    shipmentLeadId?: string;
    meta?: Record<string, unknown>;
}): Promise<void> {
    const {
        assignedBrokerId,
        ssePayload,
        broadcastType,
        notificationType,
        title,
        teamLeadTitle,
        message,
        shipmentLeadId,
        meta,
    } = options;

    const broadcast = {
        ...ssePayload,
        type: broadcastType || String(ssePayload.type || "") + "_BROADCAST",
    };

    sseEmitToRoles([...COMPANY_OPS_ROLES], broadcast);

    await platformNotificationService
        .notifyRoles({
            roles: [...COMPANY_OPS_ROLES],
            notificationType,
            title,
            message,
            shipmentLeadId,
            excludeUserId: assignedBrokerId || undefined,
            meta,
        })
        .catch(() => null);

    if (!assignedBrokerId) return;

    const teamLeadId = await getBrokerTeamLeadId(assignedBrokerId);
    if (!teamLeadId || teamLeadId === assignedBrokerId) return;

    sseEmitToUser(teamLeadId, broadcast);
    await platformNotificationService
        .notifyUser({
            userId: teamLeadId,
            notificationType,
            title: teamLeadTitle || title,
            message,
            shipmentLeadId,
            meta,
        })
        .catch(() => null);
}

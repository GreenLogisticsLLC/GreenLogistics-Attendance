import { prisma } from "../../../config/database.js";
import { Roles } from "../../../auth/roles.js";
import { platformNotificationService } from "../../shipment/services/platform-notification.service.js";
import { sseEmitToRoles, sseEmitToUser } from "./realtime.hub.js";

export function canSeeOpsComments(role: string): boolean {
    return (
        role === Roles.Administrator ||
        role === Roles.Owner ||
        role === Roles.Manager ||
        role === Roles.TeamLead
    );
}

function displayName(u: {
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
}): string {
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username || "user";
}

export async function listOpsComments(shipmentLeadId: string) {
    return prisma.shipmentOpsComment.findMany({
        where: { shipmentLeadId },
        orderBy: { createdAt: "asc" },
        take: 200,
    });
}

/**
 * Add a Team Lead / Manager / Owner comment.
 * Optionally escalate the shipment + comment to all Managers (and Owner).
 */
export async function addOpsComment(input: {
    shipmentLeadId: string;
    authorUserId: string;
    authorRole: string;
    body: string;
    sendToManager?: boolean;
}) {
    if (!canSeeOpsComments(input.authorRole)) {
        throw Object.assign(new Error("Forbidden — Brokers cannot use Comments"), {
            status: 403,
        });
    }
    const text = String(input.body || "").trim();
    if (!text) {
        throw Object.assign(new Error("Comment text is required"), { status: 422 });
    }
    if (text.length > 4000) {
        throw Object.assign(new Error("Comment is too long (max 4000)"), { status: 422 });
    }

    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: input.shipmentLeadId },
        select: {
            shipmentLeadId: true,
            greenOsShipmentId: true,
            loadNumber: true,
            shipmentTitle: true,
            assignedBrokerId: true,
            status: true,
        },
    });
    if (!lead) {
        throw Object.assign(new Error("Shipment not found"), { status: 404 });
    }

    const author = await prisma.user.findUnique({
        where: { userId: input.authorUserId },
        select: { firstName: true, lastName: true, username: true },
    });
    const authorName = author ? displayName(author) : "user";

    let brokerName: string | null = null;
    if (lead.assignedBrokerId) {
        const broker = await prisma.user.findUnique({
            where: { userId: lead.assignedBrokerId },
            select: { firstName: true, lastName: true, username: true },
        });
        brokerName = broker ? displayName(broker) : null;
    }

    const sendToManager = Boolean(input.sendToManager);
    const now = sendToManager ? new Date() : null;

    const comment = await prisma.shipmentOpsComment.create({
        data: {
            shipmentLeadId: input.shipmentLeadId,
            authorUserId: input.authorUserId,
            authorName,
            authorRole: input.authorRole,
            body: text,
            sentToManager: sendToManager,
            sentToManagerAt: now,
        },
    });

    if (sendToManager) {
        const ref =
            lead.loadNumber ||
            lead.greenOsShipmentId ||
            lead.shipmentLeadId.slice(0, 8);
        const title = `Shipment comment from ${authorName}`;
        const message = `${authorName} (${input.authorRole}) sent shipment ${ref}${
            brokerName ? ` (broker: ${brokerName})` : ""
        }: ${text.slice(0, 280)}`;

        await platformNotificationService
            .notifyRoles({
                roles: ["Manager", "Owner", "Administrator"],
                notificationType: "SHIPMENT_OPS_COMMENT",
                title,
                message,
                shipmentLeadId: lead.shipmentLeadId,
                excludeUserId: input.authorUserId,
                meta: {
                    commentId: comment.commentId,
                    authorUserId: input.authorUserId,
                    authorName,
                    authorRole: input.authorRole,
                    sendToManager: true,
                    greenOsShipmentId: lead.greenOsShipmentId,
                    loadNumber: lead.loadNumber,
                    brokerName,
                },
            })
            .catch(() => null);

        sseEmitToRoles(["Manager", "Owner", "Administrator"], {
            type: "SHIPMENT_OPS_COMMENT",
            commentId: comment.commentId,
            shipmentLeadId: lead.shipmentLeadId,
            greenOsShipmentId: lead.greenOsShipmentId,
            loadNumber: lead.loadNumber,
            authorName,
            authorRole: input.authorRole,
            bodyPreview: text.slice(0, 200),
            sendToManager: true,
            at: new Date().toISOString(),
        });
    } else {
        // Soft ping for other ops roles so Comments stay live without alerting Broker.
        sseEmitToRoles(["Manager", "Owner", "Administrator", "Team Lead"], {
            type: "SHIPMENT_OPS_COMMENT",
            commentId: comment.commentId,
            shipmentLeadId: lead.shipmentLeadId,
            authorName,
            authorRole: input.authorRole,
            sendToManager: false,
            at: new Date().toISOString(),
        });
    }

    return comment;
}

/** Escalate an existing comment to Manager (if not already sent). */
export async function sendOpsCommentToManager(input: {
    shipmentLeadId: string;
    commentId: string;
    actorUserId: string;
    actorRole: string;
}) {
    if (!canSeeOpsComments(input.actorRole)) {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
    }
    const comment = await prisma.shipmentOpsComment.findFirst({
        where: {
            commentId: input.commentId,
            shipmentLeadId: input.shipmentLeadId,
        },
    });
    if (!comment) {
        throw Object.assign(new Error("Comment not found"), { status: 404 });
    }
    if (comment.sentToManager) {
        return comment;
    }

    const updated = await prisma.shipmentOpsComment.update({
        where: { commentId: comment.commentId },
        data: { sentToManager: true, sentToManagerAt: new Date() },
    });

    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: input.shipmentLeadId },
        select: {
            shipmentLeadId: true,
            greenOsShipmentId: true,
            loadNumber: true,
            assignedBrokerId: true,
        },
    });
    const ref =
        lead?.loadNumber ||
        lead?.greenOsShipmentId ||
        input.shipmentLeadId.slice(0, 8);
    const title = `Shipment sent to Manager by ${comment.authorName}`;
    const message = `${comment.authorName} flagged shipment ${ref}: ${comment.body.slice(0, 280)}`;

    await platformNotificationService
        .notifyRoles({
            roles: ["Manager", "Owner", "Administrator"],
            notificationType: "SHIPMENT_OPS_COMMENT",
            title,
            message,
            shipmentLeadId: input.shipmentLeadId,
            excludeUserId: input.actorUserId,
            meta: {
                commentId: comment.commentId,
                sendToManager: true,
            },
        })
        .catch(() => null);

    sseEmitToRoles(["Manager", "Owner", "Administrator"], {
        type: "SHIPMENT_OPS_COMMENT",
        commentId: comment.commentId,
        shipmentLeadId: input.shipmentLeadId,
        sendToManager: true,
        at: new Date().toISOString(),
    });

    // Also ping the actor's UI if they are TL watching the same card.
    sseEmitToUser(input.actorUserId, {
        type: "SHIPMENT_OPS_COMMENT",
        commentId: comment.commentId,
        shipmentLeadId: input.shipmentLeadId,
        sendToManager: true,
        at: new Date().toISOString(),
    });

    return updated;
}

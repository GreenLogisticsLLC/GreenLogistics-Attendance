import type { Response } from "express";
import { prisma } from "../../../config/database.js";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assertShipmentAccess } from "../../../auth/access.js";
import { assignmentEngine } from "../../assignment/assignment.engine.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";

const OPS = new Set(["Owner", "Manager", "Administrator"]);
const WAITING = new Set(["NEW", "UNASSIGNED", "ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"]);

function nameOf(user: { firstName: string; lastName: string; username: string }) {
    return `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username;
}

/** Owner / Manager move a shipment or load onto another broker or team lead. */
export async function crmReassignShipmentController(req: AuthRequest, res: Response) {
    const role = req.user?.role || "";
    if (!OPS.has(role)) {
        return res.status(403).json(apiResponse(false, "Only Owner and Manager can transfer a shipment"));
    }
    const shipmentLeadId = String(req.params.id || "");
    const toUserId = String(req.body?.toUserId || "").trim();
    if (!toUserId) {
        return res.status(422).json(apiResponse(false, "Choose who should receive this shipment"));
    }
    const access = await assertShipmentAccess(req, res, shipmentLeadId);
    if (!access.ok) return;

    const target = await prisma.user.findUnique({
        where: { userId: toUserId },
        include: { role: true },
    });
    if (!target || !target.isActive || !["Broker", "Team Lead"].includes(target.role.roleName)) {
        return res.status(422).json(apiResponse(false, "Shipments can be given to a Broker or Team Lead"));
    }

    const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
    if (!lead) return res.status(404).json(apiResponse(false, "Shipment not found"));
    if (lead.assignedBrokerId === toUserId) {
        return res.json(apiResponse(true, "Already with this person", { shipmentLeadId, toUserId }));
    }

    const fromUser = lead.assignedBrokerId
        ? await prisma.user.findUnique({
              where: { userId: lead.assignedBrokerId },
              select: { firstName: true, lastName: true, username: true },
          })
        : null;
    const fromLabel = fromUser ? nameOf(fromUser) : "unassigned";
    const toLabel = nameOf(target);

    if (WAITING.has(String(lead.status || "")) && !lead.acceptedAt) {
        await assignmentEngine.assignLeadToBroker(
            shipmentLeadId,
            {
                userId: target.userId,
                username: target.username,
                firstName: target.firstName,
                lastName: target.lastName,
                employeeId: target.employeeId || "",
                displayName: toLabel,
            },
            "{}",
            { reassignFrom: fromLabel }
        );
    } else {
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { assignedBrokerId: toUserId },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "BROKER_ASSIGNED",
            title: `Transferred to ${toLabel}`,
            message: `${fromLabel} → ${toLabel}`,
            actorUserId: req.user?.userId,
            timelineStage: "BROKER_ASSIGNED",
            payload: { brokerId: toUserId, reassignFrom: fromLabel, byRole: role },
        });
    }

    return res.json(
        apiResponse(true, `Transferred to ${toLabel}`, { shipmentLeadId, toUserId, toName: toLabel })
    );
}

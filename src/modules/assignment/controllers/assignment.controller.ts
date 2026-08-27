import { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assignmentEngine } from "../assignment.engine.js";
import { prisma } from "../../../config/database.js";

export async function assignmentQueueStatusController(_req: AuthRequest, res: Response) {
    const data = await assignmentEngine.getQueueStatus();
    return res.json(apiResponse(true, "Assignment queue", data));
}

export async function assignmentLogsController(req: AuthRequest, res: Response) {
    const role = req.user?.role || "";
    if (role === "Broker") {
        const logs = await prisma.assignmentLog.findMany({
            where: { assignedUserId: req.user!.userId },
            orderBy: { createdAt: "desc" },
            take: 200,
        });
        return res.json(apiResponse(true, "Assignment logs", logs));
    }
    const logs = await assignmentEngine.listAssignmentLogs(200);
    return res.json(apiResponse(true, "Assignment logs", logs));
}

export async function assignmentEligibleController(_req: AuthRequest, res: Response) {
    const eligible = await assignmentEngine.listEligibleBrokers();
    return res.json(apiResponse(true, "Eligible brokers", eligible));
}

export async function assignmentDrainPendingController(_req: AuthRequest, res: Response) {
    try {
        await assignmentEngine.processDueAcceptances();
        const assigned = await assignmentEngine.assignPendingNewLeads(50);
        return res.json(
            apiResponse(true, `Assigned ${assigned} pending shipment(s)`, { assigned })
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Drain failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

/** Reclaim unworked + set Gmail cutoff now + drain to In Office brokers. */
export async function assignmentRefreshMailingController(req: AuthRequest, res: Response) {
    try {
        const { assignmentOpsService } = await import("../services/assignment-ops.service.js");
        const data = await assignmentOpsService.refreshMailingDistribution({
            actorUserId: req.user?.userId || null,
            drainLimit: 100,
            dismissUnread: true,
        });
        return res.json(
            apiResponse(
                true,
                `Refresh done — ${data.drained} assigned to ${data.eligibleCount} eligible broker(s)`,
                data
            )
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Refresh failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

/** Delete all shipments and start company mailing from this moment. */
export async function assignmentCleanSlateController(req: AuthRequest, res: Response) {
    const confirm = String(req.body?.confirm || "");
    if (confirm !== "CLEAN_SLATE_SHIPMENTS") {
        return res
            .status(422)
            .json(apiResponse(false, 'Pass confirm: "CLEAN_SLATE_SHIPMENTS" in the body'));
    }
    try {
        const { assignmentOpsService } = await import("../services/assignment-ops.service.js");
        const data = await assignmentOpsService.cleanSlateAllShipments({
            actorUserId: req.user?.userId || null,
        });
        return res.json(
            apiResponse(
                true,
                `Clean slate — deleted ${data.deletedShipments} shipment(s); mailing starts from now`,
                data
            )
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : "Clean slate failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

/** Link a GreenOS user to an Attendance employee (for In Office checks). */
export async function linkEmployeeController(req: AuthRequest, res: Response) {
    const userId = String(req.params.userId);
    const employeeId = String(req.body?.employeeId || "");
    if (!employeeId) {
        return res.status(422).json(apiResponse(false, "employeeId is required"));
    }
    try {
        const emp = await prisma.employee.findUnique({ where: { employeeId } });
        if (!emp) return res.status(404).json(apiResponse(false, "Employee not found"));
        const user = await prisma.user.update({
            where: { userId },
            data: { employeeId },
            select: {
                userId: true,
                username: true,
                firstName: true,
                lastName: true,
                employeeId: true,
            },
        });
        return res.json(apiResponse(true, "User linked to employee", user));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Link failed";
        return res.status(400).json(apiResponse(false, message));
    }
}

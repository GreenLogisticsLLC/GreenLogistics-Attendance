import { Response } from "express";
import { apiResponse } from "../utils/helpers.js";
import type { AuthRequest } from "../middlewares/auth.middleware.js";
import { usersService } from "../services/users.service.js";

export async function listUsersController(_req: AuthRequest, res: Response) {
    const users = await usersService.listUsers();
    return res.json(apiResponse(true, "Users loaded", users));
}

export async function listAssignableRolesController(req: AuthRequest, res: Response) {
    const roles = usersService.listAssignableRoles(req.user?.role || "");
    return res.json(apiResponse(true, "Roles loaded", roles));
}

export async function updateUserRoleController(req: AuthRequest, res: Response) {
    if (!req.user) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    try {
        const userId = String(req.params.userId || "");
        const role = String(req.body?.role || req.body?.roleName || "");
        const transferTeamToUserId =
            req.body?.transferTeamToUserId === null ||
            req.body?.transferTeamToUserId === undefined ||
            req.body?.transferTeamToUserId === ""
                ? null
                : String(req.body.transferTeamToUserId);
        const takeOverFromUserId =
            req.body?.takeOverFromUserId === null ||
            req.body?.takeOverFromUserId === undefined ||
            req.body?.takeOverFromUserId === ""
                ? null
                : String(req.body.takeOverFromUserId);
        const result = await usersService.updateUserRole(req.user, userId, role, {
            transferTeamToUserId,
            takeOverFromUserId,
        });
        if (!result.ok) {
            return res.status(result.status).json(apiResponse(false, result.message));
        }
        return res.json(apiResponse(true, result.data.message, result.data));
    } catch (err) {
        console.error("[users] updateUserRoleController:", err);
        const message = err instanceof Error ? err.message : "Update failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function updateUserTeamLeadController(req: AuthRequest, res: Response) {
    if (!req.user) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    try {
        const userId = String(req.params.userId || "");
        const teamLeadId =
            req.body?.teamLeadId === null || req.body?.teamLeadId === ""
                ? null
                : String(req.body?.teamLeadId || "");
        const result = await usersService.updateBrokerTeamLead(req.user, userId, teamLeadId);
        if (!result.ok) {
            return res.status(result.status).json(apiResponse(false, result.message));
        }
        return res.json(apiResponse(true, result.data.message, result.data));
    } catch (err) {
        console.error("[users] updateUserTeamLeadController:", err);
        const message = err instanceof Error ? err.message : "Update failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function deleteUserController(req: AuthRequest, res: Response) {
    if (!req.user) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    try {
        const userId = String(req.params.userId || "");
        const result = await usersService.deleteUser(req.user, userId);
        if (!result.ok) {
            return res.status(result.status).json(apiResponse(false, result.message));
        }
        return res.json(apiResponse(true, result.data.message, result.data));
    } catch (err) {
        console.error("[users] deleteUserController:", err);
        const message = err instanceof Error ? err.message : "Delete failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

export async function syncAttendanceBadgesController(_req: AuthRequest, res: Response) {
    try {
        const result = await usersService.backfillAttendanceBadges();
        return res.json(
            apiResponse(
                true,
                `Attendance badges synced: ${result.created} created, ${result.linked} linked (${result.checked} checked)`,
                result
            )
        );
    } catch (err) {
        console.error("[users] syncAttendanceBadgesController:", err);
        const message = err instanceof Error ? err.message : "Sync failed";
        return res.status(500).json(apiResponse(false, message));
    }
}

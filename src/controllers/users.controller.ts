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
    const userId = String(req.params.userId || "");
    const role = String(req.body?.role || req.body?.roleName || "");
    const result = await usersService.updateUserRole(req.user, userId, role);
    if (!result.ok) {
        return res.status(result.status).json(apiResponse(false, result.message));
    }
    return res.json(apiResponse(true, result.data.message, result.data));
}

export async function deleteUserController(req: AuthRequest, res: Response) {
    if (!req.user) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const userId = String(req.params.userId || "");
    const result = await usersService.deleteUser(req.user, userId);
    if (!result.ok) {
        return res.status(result.status).json(apiResponse(false, result.message));
    }
    return res.json(apiResponse(true, result.data.message, result.data));
}

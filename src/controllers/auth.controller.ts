import { Request, Response } from "express";
import { prisma } from "../config/database.js";
import { authService } from "../services/auth.service.js";
import { apiResponse } from "../utils/helpers.js";
import type { AuthRequest } from "../middlewares/auth.middleware.js";

export async function loginController(req: Request, res: Response) {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(422).json(apiResponse(false, "Username and password required"));
    }

    const result = await authService.login(username, password);
    if (!result) {
        return res.status(401).json(apiResponse(false, "Invalid credentials"));
    }

    return res.json(apiResponse(true, "Login successful", result));
}

export async function registerController(req: Request, res: Response) {
    const { username, password, firstName, lastName, email, role } = req.body;
    const result = await authService.register({
        username: username || "",
        password: password || "",
        firstName: firstName || "",
        lastName: lastName || "",
        email,
        role: role || "",
    });

    if (!result.ok) {
        return res.status(result.status).json(apiResponse(false, result.message));
    }

    return res.status(201).json(apiResponse(true, "Registration successful", result.data));
}

export async function meController(req: AuthRequest, res: Response) {
    if (!req.user) {
        return res.status(401).json(apiResponse(false, "Unauthorized"));
    }
    const user = await prisma.user.findUnique({
        where: { userId: req.user.userId },
        include: { role: true },
    });
    if (!user) {
        return res.status(401).json(apiResponse(false, "User not found"));
    }
    return res.json(
        apiResponse(true, "OK", {
            userId: user.userId,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role.roleName,
        })
    );
}

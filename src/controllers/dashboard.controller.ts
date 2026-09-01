import { Response } from "express";
import type { AuthRequest } from "../middlewares/auth.middleware.js";
import { dashboardService } from "../services/dashboard.service.js";
import { apiResponse } from "../utils/helpers.js";
import { teamScopeUserId } from "../auth/access.js";
import { listTeamEmployeeIds } from "../auth/team-scope.js";

export async function getDashboardController(req: AuthRequest, res: Response) {
    const date = req.query.date as string | undefined;
    const teamLeadUserId = teamScopeUserId(req);
    if (req.query.statsOnly === "1") {
        const data = await dashboardService.getStatisticsOnly(date, { teamLeadUserId });
        return res.json(apiResponse(true, "Dashboard statistics loaded", data));
    }
    const data = await dashboardService.getDashboard(date, { teamLeadUserId });
    return res.json(apiResponse(true, "Dashboard loaded", data));
}

export async function getEmployeeDetailController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    const date = req.query.date as string | undefined;
    const teamLeadUserId = teamScopeUserId(req);
    if (teamLeadUserId) {
        const allowed = await listTeamEmployeeIds(teamLeadUserId);
        if (!allowed.includes(employeeId)) {
            return res.status(403).json(apiResponse(false, "Forbidden — outside your team"));
        }
    }
    const data = await dashboardService.getEmployeeDetail(employeeId, date);
    if (!data) {
        return res.status(404).json(apiResponse(false, "Employee not found"));
    }
    return res.json(apiResponse(true, "Employee detail loaded", data));
}

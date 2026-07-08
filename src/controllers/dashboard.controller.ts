import { Request, Response } from "express";
import { dashboardService } from "../services/dashboard.service.js";
import { apiResponse } from "../utils/helpers.js";

export async function getDashboardController(req: Request, res: Response) {
    const date = req.query.date as string | undefined;
    const data = await dashboardService.getDashboard(date);
    return res.json(apiResponse(true, "Dashboard loaded", data));
}

export async function getEmployeeDetailController(req: Request, res: Response) {
    const employeeId = String(req.params.employeeId);
    const date = req.query.date as string | undefined;
    const data = await dashboardService.getEmployeeDetail(employeeId, date);
    if (!data) {
        return res.status(404).json(apiResponse(false, "Employee not found"));
    }
    return res.json(apiResponse(true, "Employee detail loaded", data));
}

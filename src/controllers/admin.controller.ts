import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../config/database.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { legacyIngestService } from "../services/legacy-ingest.service.js";
import { settingsService } from "../services/settings.service.js";
import { cardRegistrationService } from "../services/card-registration.service.js";
import { attendanceService } from "../services/attendance.service.js";
import { apiResponse, normalizeCardToken, getWebhookUrls, getAllNetworkIps } from "../utils/helpers.js";
import { config } from "../config/env.js";
import type { AuthRequest } from "../middlewares/auth.middleware.js";

function getDeployedCommit(): string {
    if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 7);
    try {
        const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
        const versionFile = path.join(root, "deploy-version.txt");
        const raw = fs.readFileSync(versionFile, "utf8").trim();
        return raw && raw !== "local" ? raw.slice(0, 7) : "local";
    } catch {
        return "local";
    }
}

export async function listEmployeesController(req: Request, res: Response) {
    const includeInactive = req.query.all === "true";
    const employees = includeInactive
        ? await employeeRepository.findAll()
        : await employeeRepository.findAllActive();
    return res.json(apiResponse(true, "Employees loaded", employees));
}

export async function createEmployeeController(req: AuthRequest, res: Response) {
    const {
        employeeNumber,
        firstName,
        lastName,
        department,
        position,
        cardNumber,
        externalRef,
        cardType,
        shiftId,
        syncToDevice,
    } = req.body;

    if (!employeeNumber || !firstName || !lastName || !cardNumber || !shiftId) {
        return res.status(422).json(apiResponse(false, "Missing required fields"));
    }

    const normalizedCard = normalizeCardToken(String(cardNumber).trim());
    if (!normalizedCard) {
        return res.status(422).json(apiResponse(false, "Invalid card UID — enter any unique identifier"));
    }

    try {
        const employee = await employeeRepository.create({
            employeeNumber: String(employeeNumber).trim(),
            firstName: String(firstName).trim(),
            lastName: String(lastName).trim(),
            department: department ? String(department).trim() : undefined,
            position: position ? String(position).trim() : undefined,
            cardNumber: normalizedCard,
            externalRef: externalRef ? String(externalRef).trim() : String(employeeNumber).trim(),
            cardType: cardType === 1 ? 1 : 2,
            shiftId,
        });

        try {
            await cardRegistrationService.markRegistered(normalizedCard);
        } catch (markErr) {
            console.warn("markRegistered skipped:", markErr);
        }

        let syncReport = null;
        const legacyConfig = await settingsService.getLegacyConfig();
        if (syncToDevice !== false && (legacyConfig.autoSync || syncToDevice === true)) {
            if (legacyConfig.apiUrl && legacyConfig.ingestToken) {
                syncReport = await legacyIngestService.syncEmployees([employee]);
            }
        }

        return res.status(201).json(
            apiResponse(true, "Employee created", { employee, syncReport })
        );
    } catch (error: unknown) {
        const prismaError = error as { code?: string; meta?: { target?: string[] } };
        if (prismaError.code === "P2002") {
            const field = prismaError.meta?.target?.join(", ") || "field";
            return res.status(409).json(
                apiResponse(false, `Already exists: ${field}. Use a different employee number or card.`)
            );
        }
        console.error("Create employee failed:", error);
        return res.status(500).json(apiResponse(false, "Failed to create employee"));
    }
}

export async function updateEmployeeController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    const { syncToDevice, ...updateData } = req.body;

    if (updateData.cardType !== undefined) {
        updateData.cardType = updateData.cardType === 1 ? 1 : 2;
    }
    if (updateData.cardNumber !== undefined) {
        updateData.cardNumber = normalizeCardToken(String(updateData.cardNumber).trim());
        if (!updateData.cardNumber) {
            return res.status(422).json(apiResponse(false, "Invalid card UID"));
        }
    }

    try {
        const employee = await employeeRepository.update(employeeId, updateData);

        let syncReport = null;
        const legacyConfig = await settingsService.getLegacyConfig();
        if (syncToDevice !== false && (legacyConfig.autoSync || syncToDevice === true)) {
            syncReport = await legacyIngestService.syncEmployees([employee]);
        }

        return res.json(apiResponse(true, "Employee updated", { employee, syncReport }));
    } catch (error: unknown) {
        const prismaError = error as { code?: string; meta?: { target?: string[] } };
        if (prismaError.code === "P2002") {
            const field = prismaError.meta?.target?.join(", ") || "field";
            return res.status(409).json(
                apiResponse(false, `Already exists: ${field}. Use a different employee number or card.`)
            );
        }
        console.error("Update employee failed:", error);
        return res.status(500).json(apiResponse(false, "Failed to update employee"));
    }
}

export async function deleteEmployeeController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    const employee = await employeeRepository.findById(employeeId);
    if (!employee) {
        return res.status(404).json(apiResponse(false, "Employee not found"));
    }

    try {
        await prisma.$transaction(async (tx) => {
            const sessions = await tx.attendanceSession.findMany({
                where: { employeeId },
                select: { sessionId: true },
            });
            const sessionIds = sessions.map((s) => s.sessionId);

            if (sessionIds.length) {
                await tx.absenceInterval.deleteMany({
                    where: { sessionId: { in: sessionIds } },
                });
            }
            await tx.attendanceEvent.deleteMany({ where: { employeeId } });
            await tx.attendanceSession.deleteMany({ where: { employeeId } });
            await tx.notification.deleteMany({ where: { employeeId } });
            await tx.pendingCardScan.deleteMany({
                where: { cardToken: normalizeCardToken(employee.cardNumber) },
            });
            await tx.employee.delete({ where: { employeeId } });
        });

        return res.json(apiResponse(true, "Employee deleted"));
    } catch (error) {
        console.error("Delete employee failed:", error);
        return res.status(500).json(apiResponse(false, "Failed to delete employee"));
    }
}

export async function deactivateEmployeeController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    const { syncToDevice } = req.body;

    const employee = await employeeRepository.update(employeeId, { status: "INACTIVE" });

    let syncReport = null;
    if (syncToDevice !== false) {
        syncReport = await legacyIngestService.syncEmployees([employee]);
    }

    return res.json(apiResponse(true, "Employee deactivated", { employee, syncReport }));
}

export async function markEmployeeLeftController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    try {
        const result = await attendanceService.markEmployeeLeft(employeeId);
        if (!result.updated) {
            return res.status(422).json(apiResponse(false, result.message));
        }
        return res.json(apiResponse(true, result.message, result.session));
    } catch (error) {
        console.error("Mark left failed:", error);
        return res.status(500).json(apiResponse(false, "Failed to mark employee as left"));
    }
}

export async function testEmployeeScanController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    const employee = await employeeRepository.findById(employeeId);
    if (!employee) {
        return res.status(404).json(apiResponse(false, "Employee not found"));
    }

    const now = new Date();
    const webhookId = `manual-test|${employeeId}|${now.toISOString()}|enter`;

    try {
        const result = await attendanceService.processEvent({
            employeeId: employee.employeeId,
            eventTime: now,
            direction: "ENTRY",
            deviceId: "manual-test",
            webhookId,
            source: "MANUAL_TEST",
        });

        const statusLabel =
            result.session.currentStatus === "INSIDE_OFFICE"
                ? "In Office"
                : result.session.currentStatus === "COMPLETED"
                  ? "Left"
                  : result.session.currentStatus;

        return res.json(
            apiResponse(true, `Test scan OK — status: ${statusLabel}`, {
                cardNumber: employee.cardNumber,
                direction: result.direction,
                currentStatus: result.session.currentStatus,
                duplicate: result.duplicate,
            })
        );
    } catch (error) {
        console.error("Test scan failed:", error);
        return res.status(500).json(apiResponse(false, "Test scan failed"));
    }
}

export async function syncEmployeeController(req: AuthRequest, res: Response) {
    const employeeId = String(req.params.employeeId);
    const employee = await employeeRepository.findById(employeeId);
    if (!employee) {
        return res.status(404).json(apiResponse(false, "Employee not found"));
    }

    const syncReport = await legacyIngestService.syncEmployees([employee]);
    const status = syncReport.success ? 200 : 502;
    return res.status(status).json(apiResponse(syncReport.success, syncReport.message, syncReport));
}

export async function syncAllEmployeesController(_req: AuthRequest, res: Response) {
    const employees = await employeeRepository.findAll();
    const syncReport = await legacyIngestService.syncEmployees(employees);
    const status = syncReport.success ? 200 : 502;
    return res.status(status).json(apiResponse(syncReport.success, syncReport.message, syncReport));
}

export async function getSettingsController(_req: Request, res: Response) {
    const settings = await settingsService.getIntegrationSettings();
    return res.json(apiResponse(true, "Settings loaded", settings));
}

export async function updateSettingsController(req: AuthRequest, res: Response) {
    const { legacyApiUrl, legacyIngestToken, legacyAutoSync } = req.body;

    const updated = await settingsService.updateLegacyConfig(
        {
            apiUrl: legacyApiUrl,
            ingestToken: legacyIngestToken,
            autoSync: legacyAutoSync,
        },
        req.user?.userId
    );

    return res.json(apiResponse(true, "Settings updated", updated));
}

export async function testLegacyConnectionController(_req: Request, res: Response) {
    const result = await legacyIngestService.testConnection();
    return res
        .status(result.success ? 200 : 502)
        .json(apiResponse(result.success, result.message));
}

export async function listShiftsController(_req: Request, res: Response) {
    const shifts = await prisma.shift.findMany({ where: { isActive: true } });
    return res.json(apiResponse(true, "Shifts loaded", shifts));
}

export async function dailyReportController(req: Request, res: Response) {
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    const sessions = await prisma.attendanceSession.findMany({
        where: { workDate: date },
        include: {
            employee: { include: { shift: true } },
            absenceIntervals: true,
        },
        orderBy: { employee: { lastName: "asc" } },
    });
    return res.json(apiResponse(true, "Daily report generated", { date, sessions }));
}

export async function healthController(_req: Request, res: Response) {
    try {
        await prisma.$queryRaw`SELECT 1`;
        const dbProvider = process.env.DATABASE_URL?.startsWith("postgresql")
            ? "postgresql"
            : "sqlite";
        const webhookUrls = getWebhookUrls(config.port);
        const commit = getDeployedCommit();
        return res.json({
            status: "OK",
            version: "1.0.0",
            commit,
            company: config.companyName,
            database: "ONLINE",
            databaseProvider: dbProvider,
            api: "ONLINE",
            webhook: "ONLINE",
            scheduler: "ONLINE",
            webhookUrls,
            networkIps: getAllNetworkIps(),
            webhookTokenHint: "Set in .env as WEBHOOK_SECRET",
            timestamp: new Date().toISOString(),
        });
    } catch {
        return res.status(503).json({
            status: "DEGRADED",
            database: "OFFLINE",
        });
    }
}

export async function networkInfoController(_req: Request, res: Response) {
    const webhookUrls = getWebhookUrls(config.port);
    return res.json(
        apiResponse(true, "Network info", {
            webhookUrls,
            networkIps: getAllNetworkIps(),
            port: config.port,
            host: config.host,
            webhookPath: "/api/v1/webhook/attendance",
        })
    );
}

export async function listNotificationsController(_req: Request, res: Response) {
    const notifications = await prisma.notification.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { employee: true },
    });
    return res.json(apiResponse(true, "Notifications loaded", notifications));
}

export async function listWebhookLogsController(_req: Request, res: Response) {
    const logs = await prisma.webhookLog.findMany({
        orderBy: { requestTime: "desc" },
        take: 100,
    });
    return res.json(apiResponse(true, "Webhook logs loaded", logs));
}

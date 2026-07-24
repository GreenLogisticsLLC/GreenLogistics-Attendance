import { config } from "../config/env.js";
import { prisma } from "../config/database.js";
import { diffMinutes, buildWebhookId, normalizeCardToken } from "../utils/helpers.js";
import { businessRulesEngine } from "./business-rules.engine.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { webhookLogRepository } from "../repositories/webhook-log.repository.js";
import { attendanceEventRepository } from "../repositories/attendance-event.repository.js";
import { attendanceService } from "./attendance.service.js";
import { cardRegistrationService } from "./card-registration.service.js";
import { logWebhookDecision } from "../utils/webhook-logger.js";
import type {
    LegacyWebhookPayload,
    StandardWebhookPayload,
} from "../types/attendance.types.js";

export class WebhookService {
    async processLegacyPayload(payload: LegacyWebhookPayload, rawBody: string) {
        const startTime = Date.now();
        const webhookId = buildWebhookId(payload);
        const employeeIdentifier =
            payload.external_ref || normalizeCardToken(payload.token);
        const directionHint =
            payload.direction ||
            (payload.decision?.toLowerCase().startsWith("ex") ? "out" : "in");

        try {
            const existing = await webhookLogRepository.findByWebhookId(webhookId);
            if (existing) {
                await webhookLogRepository.create({
                    webhookId,
                    employeeIdentifier,
                    requestPayload: rawBody,
                    responseCode: 200,
                    processingStatus: "DUPLICATE",
                    processingTimeMs: Date.now() - startTime,
                });
                logWebhookDecision({
                    deviceId: payload.device_id,
                    token: payload.token,
                    decision: payload.decision,
                    directionHint,
                    scannedAt: payload.scanned_at,
                    action: "DUPLICATE",
                    note: "Duplicate webhook ignored",
                });
                return { status: 200, duplicate: true, webhookId };
            }

            const existingEvent = await attendanceEventRepository.findByWebhookId(webhookId);
            if (existingEvent) {
                await webhookLogRepository.create({
                    webhookId,
                    employeeIdentifier,
                    requestPayload: rawBody,
                    responseCode: 200,
                    processingStatus: "DUPLICATE",
                    processingTimeMs: Date.now() - startTime,
                });
                logWebhookDecision({
                    deviceId: payload.device_id,
                    token: payload.token,
                    decision: payload.decision,
                    directionHint,
                    scannedAt: payload.scanned_at,
                    action: "DUPLICATE",
                    note: "Duplicate event ignored",
                });
                return { status: 200, duplicate: true, webhookId };
            }

            let employee = null;
            if (payload.external_ref) {
                employee = await employeeRepository.findByExternalRef(payload.external_ref);
            }
            if (!employee) {
                employee = await employeeRepository.findByCardNumber(payload.token);
            }

            const eventTime = new Date(payload.scanned_at);

            if (!employee) {
                await cardRegistrationService.recordUnknownScan(
                    payload.token,
                    payload.device_id,
                    eventTime
                );
                await prisma.notification.create({
                    data: {
                        notificationType: "UNKNOWN_EMPLOYEE",
                        priority: "CRITICAL",
                        message: `Unknown card: ${payload.token} (device ${payload.device_id})`,
                    },
                });
                await webhookLogRepository.create({
                    webhookId,
                    employeeIdentifier,
                    requestPayload: rawBody,
                    responseCode: 422,
                    processingStatus: "VALIDATION_ERROR",
                    processingTimeMs: Date.now() - startTime,
                    errorMessage: "Unknown employee",
                });
                logWebhookDecision({
                    deviceId: payload.device_id,
                    token: payload.token,
                    decision: payload.decision,
                    directionHint,
                    scannedAt: payload.scanned_at,
                    employeeName: null,
                    action: "NOT_FOUND",
                    status: null,
                    note: "Unknown employee / card",
                });
                return { status: 422, error: "Unknown employee", webhookId };
            }

            const result = await attendanceService.processEvent({
                employeeId: employee.employeeId,
                eventTime,
                direction: businessRulesEngine.mapLegacyDirection(payload),
                deviceId: payload.device_id,
                webhookId,
                source: `LEGACY_READER:${payload.profile_id || "default"}`,
            });

            const appliedDirection = result.direction || businessRulesEngine.mapLegacyDirection(payload);
            const action = result.duplicate
                ? "DUPLICATE"
                : appliedDirection === "EXIT"
                  ? "OUT"
                  : "IN";
            const status = result.session?.currentStatus ?? null;
            const employeeName = `${employee.firstName} ${employee.lastName}`;

            logWebhookDecision({
                deviceId: payload.device_id,
                token: payload.token,
                decision: payload.decision,
                directionHint: appliedDirection === "EXIT" ? "out" : "in",
                scannedAt: payload.scanned_at,
                employeeName,
                action,
                status,
                note: result.duplicate ? "Duplicate scan — status unchanged" : undefined,
            });

            await webhookLogRepository.create({
                webhookId,
                employeeIdentifier,
                requestPayload: rawBody,
                responseCode: 200,
                processingStatus: result.duplicate ? "DUPLICATE" : "SUCCESS",
                processingTimeMs: Date.now() - startTime,
                errorMessage: result.duplicate
                    ? undefined
                    : `→ ${action} / ${status}`,
            });

            return { status: 200, duplicate: result.duplicate, webhookId, result, action };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Processing failed";
            await webhookLogRepository.create({
                webhookId,
                employeeIdentifier,
                requestPayload: rawBody,
                responseCode: 500,
                processingStatus: "FAILED",
                processingTimeMs: Date.now() - startTime,
                errorMessage: message,
            });
            await prisma.notification.create({
                data: {
                    notificationType: "WEBHOOK_FAILURE",
                    priority: "CRITICAL",
                    message: `Webhook failed: ${message}`,
                },
            });
            console.error("[WEBHOOK] FAILED", message);
            throw error;
        }
    }

    async processStandardPayload(payload: StandardWebhookPayload, rawBody: string) {
        const startTime = Date.now();
        const webhookId = payload.webhookId;

        try {
            const existing = await attendanceEventRepository.findByWebhookId(webhookId);
            if (existing) {
                await webhookLogRepository.create({
                    webhookId,
                    employeeIdentifier: payload.employeeIdentifier,
                    requestPayload: rawBody,
                    responseCode: 200,
                    processingStatus: "DUPLICATE",
                    processingTimeMs: Date.now() - startTime,
                });
                logWebhookDecision({
                    deviceId: payload.deviceId,
                    token: payload.employeeIdentifier,
                    decision: payload.direction,
                    directionHint: payload.direction,
                    scannedAt: payload.timestamp,
                    action: "DUPLICATE",
                    note: "Duplicate webhook ignored",
                });
                return { status: 200, duplicate: true, webhookId };
            }

            let employee =
                (await employeeRepository.findByCardNumber(payload.employeeIdentifier)) ||
                (await employeeRepository.findByExternalRef(payload.employeeIdentifier)) ||
                (await employeeRepository.findByEmployeeNumber(payload.employeeIdentifier));

            if (!employee) {
                await webhookLogRepository.create({
                    webhookId,
                    employeeIdentifier: payload.employeeIdentifier,
                    requestPayload: rawBody,
                    responseCode: 422,
                    processingStatus: "VALIDATION_ERROR",
                    processingTimeMs: Date.now() - startTime,
                    errorMessage: "Unknown employee",
                });
                logWebhookDecision({
                    deviceId: payload.deviceId,
                    token: payload.employeeIdentifier,
                    decision: payload.direction,
                    directionHint: payload.direction,
                    scannedAt: payload.timestamp,
                    employeeName: null,
                    action: "NOT_FOUND",
                    note: "Unknown employee / card",
                });
                return { status: 422, error: "Unknown employee", webhookId };
            }

            const direction = businessRulesEngine.mapStandardDirection(payload.direction);
            const result = await attendanceService.processEvent({
                employeeId: employee.employeeId,
                eventTime: new Date(payload.timestamp),
                direction,
                deviceId: payload.deviceId,
                webhookId,
                source: payload.source || "ACCESS_CONTROL",
            });

            const appliedDirection = result.direction || direction;
            const action = result.duplicate
                ? "DUPLICATE"
                : appliedDirection === "EXIT"
                  ? "OUT"
                  : "IN";

            logWebhookDecision({
                deviceId: payload.deviceId,
                token: payload.employeeIdentifier,
                decision: payload.direction,
                directionHint: appliedDirection === "EXIT" ? "out" : "in",
                scannedAt: payload.timestamp,
                employeeName: `${employee.firstName} ${employee.lastName}`,
                action,
                status: result.session?.currentStatus ?? null,
                note: result.duplicate ? "Duplicate scan — status unchanged" : undefined,
            });

            await webhookLogRepository.create({
                webhookId,
                employeeIdentifier: payload.employeeIdentifier,
                requestPayload: rawBody,
                responseCode: 200,
                processingStatus: result.duplicate ? "DUPLICATE" : "SUCCESS",
                processingTimeMs: Date.now() - startTime,
            });

            return { status: 200, duplicate: result.duplicate, webhookId, result };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Processing failed";
            await webhookLogRepository.create({
                webhookId,
                employeeIdentifier: payload.employeeIdentifier,
                requestPayload: rawBody,
                responseCode: 500,
                processingStatus: "FAILED",
                processingTimeMs: Date.now() - startTime,
                errorMessage: message,
            });
            console.error("[WEBHOOK] FAILED", message);
            throw error;
        }
    }

    validateBearerToken(authHeader: string | undefined): boolean {
        if (!authHeader?.startsWith("Bearer ")) return false;
        const token = authHeader.slice(7);
        return token === config.webhookSecret;
    }
}

export const webhookService = new WebhookService();

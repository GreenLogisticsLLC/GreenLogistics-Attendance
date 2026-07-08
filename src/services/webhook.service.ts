import { config } from "../config/env.js";
import { prisma } from "../config/database.js";
import { diffMinutes, buildWebhookId, normalizeCardToken } from "../utils/helpers.js";
import { businessRulesEngine } from "./business-rules.engine.js";
import { employeeRepository } from "../repositories/employee.repository.js";
import { webhookLogRepository } from "../repositories/webhook-log.repository.js";
import { attendanceEventRepository } from "../repositories/attendance-event.repository.js";
import { attendanceService } from "./attendance.service.js";
import { cardRegistrationService } from "./card-registration.service.js";
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

            const action =
                result.direction === "EXIT" ? "left" : "entered";

            await webhookLogRepository.create({
                webhookId,
                employeeIdentifier,
                requestPayload: rawBody,
                responseCode: 200,
                processingStatus: result.duplicate ? "DUPLICATE" : "SUCCESS",
                processingTimeMs: Date.now() - startTime,
                errorMessage: result.duplicate ? undefined : `→ ${action}`,
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

            await webhookLogRepository.create({
                webhookId,
                employeeIdentifier: payload.employeeIdentifier,
                requestPayload: rawBody,
                responseCode: 200,
                processingStatus: "SUCCESS",
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

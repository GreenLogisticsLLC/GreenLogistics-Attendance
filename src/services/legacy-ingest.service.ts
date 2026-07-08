import type { Employee, Shift } from "@prisma/client";
import { settingsService } from "./settings.service.js";
import { normalizeCardToken } from "../utils/helpers.js";

export interface LegacyTicket {
    external_ref: string;
    token: string;
    type: number;
    is_active: boolean;
    days_of_week?: number;
    daily_from?: string;
    daily_to?: string;
}

export interface IngestResult {
    received: number;
    created: number;
    updated: number;
    errors: Array<{ index: number; external_ref: string; reason: string }>;
}

export interface SyncReport {
    success: boolean;
    message: string;
    batches: number;
    totalEmployees: number;
    result?: IngestResult;
    error?: string;
}

const BATCH_SIZE = 500;

export class LegacyIngestService {
    employeeToTicket(employee: Employee & { shift?: Shift }): LegacyTicket {
        const externalRef = employee.externalRef || employee.employeeNumber;
        const ticket: LegacyTicket = {
            external_ref: externalRef,
            token: normalizeCardToken(employee.cardNumber),
            type: employee.cardType === 1 ? 1 : 2,
            is_active: employee.status === "ACTIVE",
        };

        if (employee.shift) {
            ticket.days_of_week = 127;
            ticket.daily_from = employee.shift.startTime.slice(0, 5);
            ticket.daily_to = employee.shift.endTime.slice(0, 5);
        }

        return ticket;
    }

    async syncEmployees(employees: Array<Employee & { shift?: Shift }>): Promise<SyncReport> {
        const legacyConfig = await settingsService.getLegacyConfig();

        if (!legacyConfig.apiUrl) {
            return {
                success: false,
                message: "Legacy API URL not configured",
                batches: 0,
                totalEmployees: employees.length,
                error: "MISSING_API_URL",
            };
        }

        if (!legacyConfig.ingestToken) {
            return {
                success: false,
                message: "Legacy ingest token not configured",
                batches: 0,
                totalEmployees: employees.length,
                error: "MISSING_INGEST_TOKEN",
            };
        }

        if (employees.length === 0) {
            return {
                success: true,
                message: "No employees to sync",
                batches: 0,
                totalEmployees: 0,
                result: { received: 0, created: 0, updated: 0, errors: [] },
            };
        }

        const baseUrl = legacyConfig.apiUrl.replace(/\/$/, "");
        const ingestUrl = `${baseUrl}/api/legacy/ingest`;
        const tickets = employees.map((e) => this.employeeToTicket(e));

        let aggregated: IngestResult = {
            received: 0,
            created: 0,
            updated: 0,
            errors: [],
        };
        let batches = 0;

        try {
            for (let i = 0; i < tickets.length; i += BATCH_SIZE) {
                const batch = tickets.slice(i, i + BATCH_SIZE);
                const response = await fetch(ingestUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${legacyConfig.ingestToken}`,
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify({ tickets: batch }),
                });

                const body = (await response.json()) as IngestResult & { code?: string };

                if (response.status === 401) {
                    return {
                        success: false,
                        message: "Legacy ingest unauthorized — check ingest token",
                        batches,
                        totalEmployees: employees.length,
                        error: "LEGACY_INGEST_UNAUTHORIZED",
                    };
                }

                if (!response.ok) {
                    return {
                        success: false,
                        message: `Legacy API error: HTTP ${response.status}`,
                        batches,
                        totalEmployees: employees.length,
                        error: body.code || String(response.status),
                    };
                }

                aggregated.received += body.received || batch.length;
                aggregated.created += body.created || 0;
                aggregated.updated += body.updated || 0;
                aggregated.errors.push(...(body.errors || []));
                batches++;
            }

            return {
                success: aggregated.errors.length === 0,
                message:
                    aggregated.errors.length === 0
                        ? `Synced ${employees.length} card(s) to device`
                        : `Synced with ${aggregated.errors.length} error(s)`,
                batches,
                totalEmployees: employees.length,
                result: aggregated,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Network error";
            return {
                success: false,
                message: `Failed to reach Legacy API: ${message}`,
                batches,
                totalEmployees: employees.length,
                error: message,
            };
        }
    }

    async testConnection(): Promise<{ success: boolean; message: string }> {
        const legacyConfig = await settingsService.getLegacyConfig();

        if (!legacyConfig.apiUrl || !legacyConfig.ingestToken) {
            return { success: false, message: "Configure Legacy API URL and ingest token first" };
        }

        const baseUrl = legacyConfig.apiUrl.replace(/\/$/, "");
        try {
            const response = await fetch(`${baseUrl}/api/legacy/ingest`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${legacyConfig.ingestToken}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({ tickets: [] }),
            });

            if (response.status === 401) {
                return { success: false, message: "Unauthorized — invalid ingest token" };
            }
            if (response.status === 422) {
                return { success: true, message: "Connection OK (empty batch accepted)" };
            }
            if (response.ok) {
                return { success: true, message: "Connection OK — Legacy API reachable" };
            }
            return { success: false, message: `Legacy API returned HTTP ${response.status}` };
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : "Connection failed",
            };
        }
    }
}

export const legacyIngestService = new LegacyIngestService();

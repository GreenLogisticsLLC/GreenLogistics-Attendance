/**
 * Centralized CarrierView HTTP client.
 * All CarrierView API traffic goes through here. Never log the API token.
 */

import { config } from "../../../../config/env.js";
import {
    CarrierViewNotConfigured,
    CarrierViewRateLimited,
    mapCarrierViewError,
} from "./errors.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CarrierViewApiResult<T = unknown> = {
    success: boolean;
    data?: T;
    error_code?: string;
    errors?: unknown;
    message?: string;
};

function assertConfigured() {
    if (!config.carrierView.apiBaseUrl || !config.carrierView.apiToken) {
        throw new CarrierViewNotConfigured();
    }
}

export class CarrierViewClient {
    private baseUrl(): string {
        assertConfigured();
        return config.carrierView.apiBaseUrl;
    }

    private token(): string {
        assertConfigured();
        return config.carrierView.apiToken;
    }

    isConfigured(): boolean {
        return Boolean(config.carrierView.apiBaseUrl && config.carrierView.apiToken);
    }

    async request<T = unknown>(
        method: HttpMethod,
        path: string,
        body?: unknown,
        query?: Record<string, string | number | undefined | null>
    ): Promise<CarrierViewApiResult<T>> {
        const url = new URL(this.baseUrl() + path);
        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v != null && v !== "") url.searchParams.set(k, String(v));
            }
        }

        console.log(`[CARRIERVIEW_API] ${method} ${path}`);

        let res: Response;
        try {
            res = await fetch(url.toString(), {
                method,
                headers: {
                    Authorization: `Bearer ${this.token()}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        } catch (err) {
            console.error(
                "[CARRIERVIEW_API] network_error",
                err instanceof Error ? err.message : err
            );
            throw mapCarrierViewError("internal_error", { network: true }, 502);
        }

        if (res.status === 429) {
            throw new CarrierViewRateLimited({ status: 429 });
        }

        let json: CarrierViewApiResult<T> = { success: false };
        const text = await res.text();
        try {
            json = text ? (JSON.parse(text) as CarrierViewApiResult<T>) : { success: false };
        } catch {
            json = { success: false, error_code: "internal_error", errors: { body: text.slice(0, 500) } };
        }

        // CarrierView may return HTTP 200 with success:false — always inspect body.
        if (json.success === false || (res.ok === false && json.success !== true)) {
            const code = json.error_code || (res.status === 429 ? "rate_limited" : "internal_error");
            console.warn(`[CARRIERVIEW_API] fail code=${code} http=${res.status}`);
            throw mapCarrierViewError(code, json.errors ?? json, res.status);
        }

        return json;
    }

    getProfile() {
        return this.request("GET", "/api/profile");
    }

    getIntegrationTypes() {
        return this.request("GET", "/api/loads/integration-types");
    }

    createLoad(body: Record<string, unknown>) {
        return this.request("POST", "/api/loads", body);
    }

    getLoad(id: string | number) {
        return this.request("GET", `/api/loads/${encodeURIComponent(String(id))}`);
    }

    searchLoads(params: {
        filter?: "all" | "past" | "active" | "future";
        phone?: string;
        page?: number;
        per_page?: number;
    }) {
        const perPage = Math.min(Math.max(params.per_page ?? 20, 1), 100);
        return this.request("GET", "/api/loads", undefined, {
            filter: params.filter || "all",
            phone: params.phone,
            page: params.page ?? 1,
            per_page: perPage,
        });
    }

    editLoad(id: string | number, body: Record<string, unknown>) {
        return this.request("PATCH", `/api/loads/${encodeURIComponent(String(id))}`, body);
    }

    disableLoad(id: string | number) {
        return this.request("PATCH", `/api/loads/${encodeURIComponent(String(id))}/disable`);
    }

    getLastPosition(id: string | number) {
        return this.request("GET", `/api/loads/${encodeURIComponent(String(id))}/last-position`);
    }

    getPositionsHistory(
        id: string | number,
        params?: { page?: number; per_page?: number; order?: "asc" | "desc" }
    ) {
        return this.request(
            "GET",
            `/api/loads/${encodeURIComponent(String(id))}/positions-history`,
            undefined,
            {
                page: params?.page ?? 1,
                per_page: Math.min(Math.max(params?.per_page ?? 50, 1), 100),
                order: params?.order ?? "desc",
            }
        );
    }

    setPositionWebhook(webhookUrl: string) {
        return this.request("PUT", "/api/webhook/new-position-sent", { webhook_url: webhookUrl });
    }

    setLoadStatusWebhook(webhookUrl: string) {
        return this.request("PUT", "/api/webhook/load-status-changed", { webhook_url: webhookUrl });
    }

    setChatWebhook(webhookUrl: string) {
        return this.request("PUT", "/api/webhook/chat-message-created-by-driver", {
            webhook_url: webhookUrl,
        });
    }

    sendChatMessage(id: string | number, message: string) {
        return this.request("POST", `/api/loads/${encodeURIComponent(String(id))}/chat-message`, {
            message,
        });
    }

    sendTextMessage(
        id: string | number,
        body: { type: string; message?: string }
    ) {
        return this.request("POST", `/api/loads/${encodeURIComponent(String(id))}/text-message`, body);
    }
}

export const carrierViewClient = new CarrierViewClient();

import { getOpenAiConfig } from "../../../config/env.js";
import { estimateCostUsd } from "./ai-pricing.js";

export type AiChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

export type AiGatewayResult = {
    reply: string;
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    estimatedCostUsd: number | null;
};

/**
 * Single OpenAI Chat Completions gateway — reuses existing env/config.
 * Do not create a second OpenAI client elsewhere.
 */
export class AiGateway {
    isConfigured(): boolean {
        const key = getOpenAiConfig().apiKey;
        if (!key) return false;
        if (key.startsWith("sk-admin-")) return false;
        return true;
    }

    getModel(): string {
        return getOpenAiConfig().model || "gpt-4o-mini";
    }

    isEnabled(): boolean {
        const flag = String(process.env.AI_ENABLED || "true").trim().toLowerCase();
        if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
        return true;
    }

    async chatCompletions(input: {
        messages: AiChatMessage[];
        temperature?: number;
        maxCompletionTokens?: number;
    }): Promise<AiGatewayResult> {
        if (!this.isEnabled()) {
            throw Object.assign(new Error("GreenOS AI is disabled (AI_ENABLED=false)"), {
                status: 503,
                code: "AI_DISABLED",
            });
        }
        const openai = getOpenAiConfig();
        if (!this.isConfigured()) {
            const key = openai.apiKey;
            const msg = key.startsWith("sk-admin-")
                ? "OPENAI_API_KEY is an Admin key — use a Project API key (sk-proj-...) from GreenOS → API keys."
                : "OPENAI_API_KEY is not configured. Add it to the server .env and restart GreenOS.";
            throw Object.assign(new Error(msg), { status: 503 });
        }

        const model = this.getModel();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${openai.apiKey}`,
            "Content-Type": "application/json",
        };
        const key = openai.apiKey;
        if (!key.startsWith("sk-proj-")) {
            if (openai.projectId) headers["OpenAI-Project"] = openai.projectId;
            if (openai.organizationId) headers["OpenAI-Organization"] = openai.organizationId;
        }

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                messages: input.messages,
                temperature: input.temperature ?? 0.3,
                max_completion_tokens: input.maxCompletionTokens ?? 1200,
            }),
        });

        const data = (await res.json().catch(() => ({}))) as {
            error?: { message?: string; code?: string; type?: string };
            choices?: Array<{ message?: { content?: string } }>;
            model?: string;
            usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
            };
        };

        if (!res.ok) {
            const code = data?.error?.code || "";
            const detail = data?.error?.message || `OpenAI HTTP ${res.status}`;
            const keySuffix = key ? key.slice(-4) : "none";
            console.warn(
                `[ai] OpenAI error model=${model} keySuffix=${keySuffix} http=${res.status} code=${code || "none"}`
            );
            let friendly = detail;
            if (code === "insufficient_quota" || /no credits remaining/i.test(detail)) {
                friendly =
                    "OpenAI API billing: no credits on this organization/project. " +
                    "Add API credits at platform.openai.com → Settings → Billing.";
            } else if (code === "invalid_api_key") {
                friendly = "OpenAI API key is invalid or revoked.";
            } else if (code === "model_not_found") {
                friendly = `OpenAI model "${model}" is not available. Set OPENAI_MODEL to gpt-4o-mini.`;
            }
            throw Object.assign(new Error(friendly), {
                status: res.status >= 500 ? 502 : 400,
                code: "OPENAI_ERROR",
            });
        }

        const reply = data.choices?.[0]?.message?.content?.trim();
        if (!reply) {
            throw Object.assign(new Error("Empty response from OpenAI"), { status: 502 });
        }

        const usedModel = data.model || model;
        const promptTokens = data.usage?.prompt_tokens ?? null;
        const completionTokens = data.usage?.completion_tokens ?? null;
        const totalTokens =
            data.usage?.total_tokens ??
            (promptTokens != null && completionTokens != null
                ? promptTokens + completionTokens
                : null);

        return {
            reply,
            model: usedModel,
            promptTokens,
            completionTokens,
            totalTokens,
            estimatedCostUsd: estimateCostUsd({
                model: usedModel,
                promptTokens,
                completionTokens,
            }),
        };
    }
}

export const aiGateway = new AiGateway();

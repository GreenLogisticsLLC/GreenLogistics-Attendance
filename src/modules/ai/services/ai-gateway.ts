import { getOpenAiConfig } from "../../../config/env.js";
import { estimateCostUsd } from "./ai-pricing.js";

export type AiChatMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
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

    /**
     * Multimodal vision call — same OpenAI config/client path (no second client).
     * Used for signature-region inspection when DOC_AI_VISION=true.
     */
    async visionJson(input: {
        prompt: string;
        imageBase64: string;
        mimeType?: string;
        temperature?: number;
        maxCompletionTokens?: number;
    }): Promise<AiGatewayResult & { parsed: Record<string, unknown> | null }> {
        const mime = input.mimeType || "image/jpeg";
        const result = await this.chatCompletions({
            messages: [
                {
                    role: "system",
                    content:
                        "You are a document vision assistant for GreenOS. " +
                        "Respond with ONLY valid JSON. Never invent GreenOS master data. " +
                        "Never return SSN/EIN full values.",
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: input.prompt },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mime};base64,${input.imageBase64}`,
                            },
                        },
                    ],
                },
            ],
            temperature: input.temperature ?? 0.1,
            maxCompletionTokens: input.maxCompletionTokens ?? 400,
        });
        let parsed: Record<string, unknown> | null = null;
        try {
            const raw = result.reply.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
            parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            parsed = null;
        }
        return { ...result, parsed };
    }
}

export const aiGateway = new AiGateway();

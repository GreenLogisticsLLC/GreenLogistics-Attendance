import { config } from "../../../config/env.js";

export type AiChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

const SYSTEM_PROMPT = `You are GreenOS AI Assistant for Green Logistics (freight brokerage / car transport).
Help with: attendance (In Office / Out of Office), shipment assignment, CRM shipment cards,
uShip workflow (marketplace stays external), load numbers on the same shipment card, operations,
and internal notifications.
Be concise and practical. If data is missing, say what the user should check in GreenOS.
Never invent confidential customer or financial data.`;

/**
 * Call OpenAI Chat Completions for GreenOS AI Assistant.
 */
export class AiAssistantService {
    isConfigured(): boolean {
        return Boolean(config.openai.apiKey);
    }

    getModel(): string {
        return config.openai.model || "gpt-5.5";
    }

    async chat(input: {
        message: string;
        history?: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{ reply: string; model: string }> {
        if (!this.isConfigured()) {
            throw Object.assign(
                new Error(
                    "OPENAI_API_KEY is not configured. Add it to the server .env and restart GreenOS."
                ),
                { status: 503 }
            );
        }

        const message = String(input.message || "").trim();
        if (!message) {
            throw Object.assign(new Error("message is required"), { status: 422 });
        }

        const history = (input.history || []).slice(-12).map((m) => ({
            role: m.role,
            content: String(m.content || "").slice(0, 4000),
        }));

        const messages: AiChatMessage[] = [
            { role: "system", content: SYSTEM_PROMPT },
            ...history,
            { role: "user", content: message.slice(0, 8000) },
        ];

        const model = this.getModel();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${config.openai.apiKey}`,
            "Content-Type": "application/json",
        };
        if (config.openai.projectId) headers["OpenAI-Project"] = config.openai.projectId;
        if (config.openai.organizationId) headers["OpenAI-Organization"] = config.openai.organizationId;
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.4,
                max_completion_tokens: 1200,
            }),
        });

        const data = (await res.json().catch(() => ({}))) as {
            error?: { message?: string; code?: string; type?: string };
            choices?: Array<{ message?: { content?: string } }>;
            model?: string;
        };

        if (!res.ok) {
            const code = data?.error?.code || "";
            const detail = data?.error?.message || `OpenAI HTTP ${res.status}`;
            let friendly = detail;
            if (code === "insufficient_quota" || /no credits remaining/i.test(detail)) {
                friendly =
                    "OpenAI API billing: no credits on this organization/project. " +
                    "Add API credits at platform.openai.com → Settings → Billing (same org as project GreenOS), " +
                    "then create a Project API key in GreenOS → API keys.";
            } else if (code === "invalid_api_key") {
                friendly = "OpenAI API key is invalid or revoked. Create a new Project API key in GreenOS.";
            } else if (code === "model_not_found") {
                friendly = `OpenAI model "${model}" is not available on this account. Set OPENAI_MODEL to gpt-4o-mini.`;
            }
            throw Object.assign(new Error(friendly), { status: res.status >= 500 ? 502 : 400 });
        }

        const reply = data.choices?.[0]?.message?.content?.trim();
        if (!reply) {
            throw Object.assign(new Error("Empty response from OpenAI"), { status: 502 });
        }

        return { reply, model: data.model || model };
    }
}

export const aiAssistantService = new AiAssistantService();

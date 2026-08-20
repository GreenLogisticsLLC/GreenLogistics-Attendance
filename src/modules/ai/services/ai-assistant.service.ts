/**
 * Legacy thin wrapper — Phase 1 chat goes through AiOrchestrator + AiGateway.
 * Kept so existing imports/tests keep working.
 */
import { aiGateway } from "./ai-gateway.js";

export type AiChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

export class AiAssistantService {
    isConfigured(): boolean {
        return aiGateway.isConfigured();
    }

    getModel(): string {
        return aiGateway.getModel();
    }

    async chat(input: {
        message: string;
        history?: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{ reply: string; model: string }> {
        const message = String(input.message || "").trim();
        if (!message) {
            throw Object.assign(new Error("message is required"), { status: 422 });
        }
        const history = (input.history || []).slice(-12).map((m) => ({
            role: m.role as "user" | "assistant",
            content: String(m.content || "").slice(0, 4000),
        }));
        const llm = await aiGateway.chatCompletions({
            messages: [
                {
                    role: "system",
                    content:
                        "You are GreenOS AI Assistant for Green Logistics. Be concise. " +
                        "Never invent confidential customer or financial data. " +
                        'Prefix: "[General AI answer — not GreenOS data] "',
                },
                ...history,
                { role: "user", content: message.slice(0, 8000) },
            ],
            temperature: 0.4,
        });
        let reply = llm.reply;
        if (!reply.startsWith("[General AI answer")) {
            reply = `[General AI answer — not GreenOS data] ${reply}`;
        }
        return { reply, model: llm.model };
    }
}

export const aiAssistantService = new AiAssistantService();

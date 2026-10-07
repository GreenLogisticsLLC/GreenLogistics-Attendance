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
                        "You are GREEN, the GreenOS AI Agent for Green Logistics brokers. Be concise. " +
                        "Never invent confidential customer or financial data. " +
                        "Do not prefix replies with labels like [General AI answer].",
                },
                ...history,
                { role: "user", content: message.slice(0, 8000) },
            ],
            temperature: 0.4,
        });
        return { reply: llm.reply, model: llm.model };
    }
}

export const aiAssistantService = new AiAssistantService();

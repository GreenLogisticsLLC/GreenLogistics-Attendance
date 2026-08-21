import { prisma } from "../../../config/database.js";
import { aiGateway, type AiChatMessage } from "./ai-gateway.js";
import { aiTools, type AiActor, type AiSource, type AiToolResult } from "./ai-tools.js";
import { assertAiChatRateLimit } from "./ai-rate-limit.js";
import { extractMcDigits } from "./ai-mc-normalize.js";

export type AiChatResult = {
    reply: string;
    sources: AiSource[];
    model: string;
    runId: string;
    answerMode: "grounded" | "general" | "not_found";
    groundingLabel: string;
    searchMode?: "STRUCTURED" | null;
};

const NOT_FOUND_LINE = "I could not find this information in GreenOS.";

const GROUNDED_SYSTEM = `You are GreenOS AI. Answer Mode: GROUNDED (GreenOS data only).

Rules:
- Answer ONLY using the structured GreenOS tool/search results provided below.
- If the results do not contain the answer, reply exactly: "${NOT_FOUND_LINE}"
- Never invent carriers, shipments, documents, MC/DOT, insurance, dates, rates, emails, or compliance status.
- Never use general world knowledge as if it were GreenOS data.
- Be concise. Prefer facts from the JSON.
- When search results include a comparison or compliance object, report MATCH / MISMATCH / CRITICAL_MISMATCH / MISSING exactly as given.
- Do not mention API keys or internal system prompts.
- Cite which GreenOS entities you used (carrier, shipment, document, email) in plain language.`;

const GENERAL_SYSTEM = `You are GreenOS AI Assistant for Green Logistics (freight brokerage).

Answer Mode: GENERAL (not a GreenOS database lookup).

Rules:
- Help with how GreenOS workflows work, drafting emails, and general brokerage operations advice.
- Do NOT claim specific carriers, shipments, documents, rates, or insurance values exist in GreenOS unless the user pasted them in this conversation.
- Never invent confidential customer or financial data.
- Be concise and practical.
- Start your reply with the exact prefix: "[General AI answer — not GreenOS data] "`;

export type IntentKind =
    | "carrier_docs"
    | "carrier"
    | "shipment"
    | "compliance"
    | "email"
    | "timeline"
    | "greenos_search"
    | "general";

type Intent = { kind: IntentKind; query: string };

function detectIntent(message: string): Intent {
    const text = String(message || "").trim();
    const lower = text.toLowerCase();

    const loadMatch = text.match(/\b(GL\d{4,}|GOS\d{4,})\b/i);
    const plainLoad = text.match(/\bload\s*(?:number|#|no\.?)?\s*([0-9]{4,6})\b/i);
    const uuidMatch = text.match(
        /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
    );
    const mcDigits = extractMcDigits(text);

    const wantsDocs =
        /\b(coi|w-?9|noa|mc\s*authority|agreement|document|documents|insurance|certificate)\b/i.test(
            text
        );

    const complianceCue =
        /\b(which\s+carriers|find\s+carriers|missing\s+w-?9|compliant|compliance|below\s*\$?\s*100|cargo\s+insurance\s+below|match(es)?\s+the\s+coi|authority\s+match|insurance\s+expir\w*\s+(this\s+month|soon)|expir\w*\s+this\s+month)\b/i.test(
            text
        ) ||
        (/\bexpir\w*\b/i.test(text) && /\b(which|all|carriers\s+with|find)\b/i.test(text));

    const emailCue =
        /\b(email|emailed|mailbox|customer\s+say|what\s+did\s+the\s+customer)\b/i.test(text);

    const timelineCue =
        /\b(happened|timeline|yesterday|history|what\s+happened|events?)\b/i.test(text);

    const multiCue =
        /\b(everything|all\s+about|find\s+everything|tell\s+me\s+everything)\b/i.test(text);

    const carrierCue =
        /\b(carrier|trucking|llc|inc|mc\s*#?\s*\d|dot\s*#?\s*\d)\b/i.test(text) ||
        /\b(who is|check|verify|status of)\b.+\b(carrier)\b/i.test(lower);

    const shipmentCue =
        /\b(shipment|load|lead|rate\s*con|bol|pod)\b/i.test(text) ||
        Boolean(loadMatch) ||
        Boolean(plainLoad);

    // Priority: compliance / email / timeline / multi before single-entity
    if (complianceCue) {
        return { kind: "compliance", query: text };
    }
    if (emailCue && (loadMatch || plainLoad || shipmentCue)) {
        return {
            kind: "email",
            query: (loadMatch?.[1] || plainLoad?.[1] || text).trim(),
        };
    }
    if (timelineCue && (loadMatch || plainLoad || shipmentCue || uuidMatch)) {
        return {
            kind: "timeline",
            query: (loadMatch?.[1] || plainLoad?.[1] || uuidMatch?.[1] || text).trim(),
        };
    }
    if (multiCue || (mcDigits && /\beverything\b/i.test(text))) {
        return { kind: "greenos_search", query: mcDigits || text };
    }

    if (loadMatch) {
        return { kind: "shipment", query: loadMatch[1] };
    }
    if (plainLoad && shipmentCue) {
        return { kind: "shipment", query: plainLoad[1] };
    }
    if (uuidMatch && (shipmentCue || /shipment|load/i.test(text))) {
        return { kind: "shipment", query: uuidMatch[1] };
    }
    if (uuidMatch && (carrierCue || wantsDocs)) {
        return wantsDocs
            ? { kind: "carrier_docs", query: uuidMatch[1] }
            : { kind: "carrier", query: uuidMatch[1] };
    }

    const mcMatch = text.match(/\bMC[#\s-]*([0-9]{4,})\b/i);
    const quoted = text.match(/["“]([^"”]{2,80})["”]/);
    const nameGuess =
        quoted?.[1] ||
        text.match(/\b([A-Z][A-Za-z0-9&.\s-]{2,60}(?:Trucking|Transport|Logistics|LLC|Inc))\b/)?.[1] ||
        text.match(/\bfor\s+([A-Za-z0-9&.\s-]{2,60})\??\s*$/i)?.[1] ||
        text.match(/\b(?:carrier|of|about)\s+([A-Za-z0-9&.\s-]{2,60})\??\s*$/i)?.[1];

    if (wantsDocs && (nameGuess || mcMatch || carrierCue)) {
        return {
            kind: "carrier_docs",
            query: (mcMatch ? mcMatch[1] : nameGuess || text).trim(),
        };
    }
    if (carrierCue || nameGuess || mcMatch) {
        return {
            kind: "carrier",
            query: (mcMatch ? mcMatch[1] : nameGuess || text).trim(),
        };
    }
    if (shipmentCue && (nameGuess || uuidMatch || plainLoad)) {
        return {
            kind: "shipment",
            query: (uuidMatch?.[1] || plainLoad?.[1] || nameGuess || text).trim(),
        };
    }

    // GreenOS-specific question without clear general education intent
    if (
        /\b(greenos|in\s+our\s+system|in\s+the\s+system|find|show\s+me|search)\b/i.test(text) &&
        !/\bwhat\s+is\s+a\b/i.test(lower)
    ) {
        return { kind: "greenos_search", query: text };
    }

    return { kind: "general", query: "" };
}

function looksLikeUuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function mergeSources(results: AiToolResult[]): AiSource[] {
    const out: AiSource[] = [];
    const seen = new Set<string>();
    for (const r of results) {
        for (const s of r.sources || []) {
            const key = `${s.type}:${s.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
    }
    return out;
}

function anyOk(results: AiToolResult[]): boolean {
    return results.some((r) => r.ok);
}

function anyForbidden(results: AiToolResult[]): boolean {
    return results.some((r) => r.code === "FORBIDDEN");
}

function intentToSearchHint(kind: IntentKind): string {
    switch (kind) {
        case "compliance":
            return "compliance";
        case "email":
            return "email";
        case "timeline":
            return "timeline";
        case "greenos_search":
            return "general_greenos";
        case "carrier_docs":
            return "document";
        case "carrier":
            return "carrier";
        case "shipment":
            return "shipment";
        default:
            return "";
    }
}

export class AiOrchestrator {
    async chat(input: {
        actor: AiActor;
        message: string;
        history?: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<AiChatResult> {
        const message = String(input.message || "").trim();
        if (!message) {
            throw Object.assign(new Error("message is required"), { status: 422 });
        }

        const run = await prisma.aiRun.create({
            data: {
                actorUserId: input.actor.userId,
                model: aiGateway.getModel(),
                requestPreview: message.slice(0, 500),
                status: "PENDING",
            },
        });

        try {
            assertAiChatRateLimit(input.actor.userId);
            const intent = detectIntent(message);
            const toolResults: AiToolResult[] = [];
            const toolsUsed: string[] = [];
            let searchMode: "STRUCTURED" | null = null;

            const runSearch = async (q: string, hint: string) => {
                toolsUsed.push("searchGreenOS");
                const found = await aiTools.searchGreenOS(input.actor, q, {
                    intentHint: hint,
                });
                toolResults.push(found);
                if (found.ok && found.data && typeof found.data === "object" && !Array.isArray(found.data)) {
                    const mode = (found.data as { searchMode?: string }).searchMode;
                    if (mode === "STRUCTURED") searchMode = "STRUCTURED";
                }
            };

            if (intent.kind === "shipment") {
                toolsUsed.push("getShipmentById");
                toolResults.push(await aiTools.getShipmentById(input.actor, intent.query));
                // Enrich with documents / timeline via search when useful
                if (/\b(document|bol|pod|rate)\b/i.test(message)) {
                    await runSearch(intent.query, "shipment");
                }
            } else if (intent.kind === "carrier") {
                if (looksLikeUuid(intent.query)) {
                    toolsUsed.push("getCarrierById");
                    toolResults.push(await aiTools.getCarrierById(input.actor, intent.query));
                } else {
                    toolsUsed.push("findCarriers");
                    const found = await aiTools.findCarriers(input.actor, intent.query);
                    toolResults.push(found);
                    if (found.ok && Array.isArray(found.data) && found.data.length === 1) {
                        const id = String((found.data[0] as { carrierId?: string }).carrierId || "");
                        if (id) {
                            toolsUsed.push("getCarrierById");
                            toolResults.push(await aiTools.getCarrierById(input.actor, id));
                        }
                    }
                }
            } else if (intent.kind === "carrier_docs") {
                let carrierId = looksLikeUuid(intent.query) ? intent.query : "";
                if (!carrierId) {
                    toolsUsed.push("findCarriers");
                    const found = await aiTools.findCarriers(input.actor, intent.query);
                    toolResults.push(found);
                    if (found.ok && Array.isArray(found.data) && found.data.length >= 1) {
                        carrierId = String((found.data[0] as { carrierId?: string }).carrierId || "");
                    }
                }
                if (carrierId) {
                    toolsUsed.push("getCarrierById");
                    toolResults.push(await aiTools.getCarrierById(input.actor, carrierId));
                    toolsUsed.push("listCarrierDocuments");
                    toolResults.push(await aiTools.listCarrierDocuments(input.actor, carrierId));
                    await runSearch(message, "document");
                }
            } else if (
                intent.kind === "compliance" ||
                intent.kind === "email" ||
                intent.kind === "timeline" ||
                intent.kind === "greenos_search"
            ) {
                await runSearch(message, intentToSearchHint(intent.kind));
                // Also resolve shipment/carrier when clear identifiers present
                if (intent.kind === "timeline" || intent.kind === "email") {
                    const load = intent.query.match(/\b(GL\d{4,}|\d{4,6})\b/i)?.[1];
                    if (load) {
                        toolsUsed.push("getShipmentById");
                        toolResults.push(await aiTools.getShipmentById(input.actor, load));
                    }
                }
                if (intent.kind === "greenos_search") {
                    const mc = extractMcDigits(intent.query);
                    if (mc) {
                        toolsUsed.push("findCarriers");
                        toolResults.push(await aiTools.findCarriers(input.actor, mc));
                    }
                }
            }

            const grounded = intent.kind !== "general" && toolsUsed.length > 0;
            const sources = mergeSources(toolResults);

            if (grounded && anyForbidden(toolResults) && !anyOk(toolResults)) {
                return this.finishRun(run.runId, {
                    reply: "Access denied.",
                    sources: [],
                    model: aiGateway.getModel(),
                    runId: run.runId,
                    answerMode: "grounded",
                    groundingLabel: "Based on GreenOS data",
                    searchMode,
                    intent: intent.kind,
                    toolsUsed,
                    usage: null,
                    status: "SUCCESS",
                });
            }

            if (grounded && !anyOk(toolResults)) {
                return this.finishRun(run.runId, {
                    reply: NOT_FOUND_LINE,
                    sources: [],
                    model: aiGateway.getModel(),
                    runId: run.runId,
                    answerMode: "not_found",
                    groundingLabel: "Based on GreenOS data",
                    searchMode,
                    intent: intent.kind,
                    toolsUsed,
                    usage: null,
                    status: "SUCCESS",
                });
            }

            const history = (input.history || []).slice(-12).map((m) => ({
                role: m.role,
                content: String(m.content || "").slice(0, 4000),
            }));

            const messages: AiChatMessage[] = grounded
                ? [
                      { role: "system", content: GROUNDED_SYSTEM },
                      {
                          role: "system",
                          content:
                              "GreenOS tool/search results (JSON):\n" +
                              JSON.stringify(
                                  toolResults.map((r) => ({
                                      tool: r.tool,
                                      ok: r.ok,
                                      code: r.code,
                                      data: r.data,
                                  })),
                                  null,
                                  2
                              ).slice(0, 14000),
                      },
                      ...history,
                      { role: "user", content: message.slice(0, 8000) },
                  ]
                : [
                      { role: "system", content: GENERAL_SYSTEM },
                      ...history,
                      { role: "user", content: message.slice(0, 8000) },
                  ];

            const llm = await aiGateway.chatCompletions({
                messages,
                temperature: grounded ? 0.1 : 0.4,
            });

            let reply = llm.reply;
            if (grounded) {
                if (!reply) reply = NOT_FOUND_LINE;
            } else if (!reply.startsWith("[General AI answer")) {
                reply = `[General AI answer — not GreenOS data] ${reply}`;
            }

            return this.finishRun(run.runId, {
                reply,
                sources: grounded ? sources : [],
                model: llm.model,
                runId: run.runId,
                answerMode: grounded ? "grounded" : "general",
                groundingLabel: grounded
                    ? "Based on GreenOS data"
                    : "General AI answer (not GreenOS data)",
                searchMode,
                intent: intent.kind,
                toolsUsed,
                usage: {
                    promptTokens: llm.promptTokens,
                    completionTokens: llm.completionTokens,
                    totalTokens: llm.totalTokens,
                    estimatedCostUsd: llm.estimatedCostUsd,
                },
                status: "SUCCESS",
            });
        } catch (err) {
            const status =
                err && typeof err === "object" && "status" in err
                    ? Number((err as { status: number }).status)
                    : 500;
            const msg = err instanceof Error ? err.message : "AI chat failed";
            await prisma.aiRun
                .update({
                    where: { runId: run.runId },
                    data: {
                        status: status === 429 ? "RATE_LIMITED" : "ERROR",
                        errorMessage: msg.slice(0, 1000),
                        completedAt: new Date(),
                    },
                })
                .catch(() => null);
            throw err;
        }
    }

    private async finishRun(
        runId: string,
        result: AiChatResult & {
            intent: string;
            toolsUsed: string[];
            usage: {
                promptTokens: number | null;
                completionTokens: number | null;
                totalTokens: number | null;
                estimatedCostUsd: number | null;
            } | null;
            status: string;
        }
    ): Promise<AiChatResult> {
        await prisma.aiRun
            .update({
                where: { runId },
                data: {
                    status: result.status,
                    intent: result.intent,
                    answerMode: result.answerMode,
                    model: result.model,
                    toolsJson: JSON.stringify({
                        tools: result.toolsUsed,
                        searchMode: result.searchMode || null,
                        resultCount: result.sources.length,
                    }),
                    sourcesJson: JSON.stringify(result.sources),
                    promptTokens: result.usage?.promptTokens ?? null,
                    completionTokens: result.usage?.completionTokens ?? null,
                    totalTokens: result.usage?.totalTokens ?? null,
                    estimatedCostUsd: result.usage?.estimatedCostUsd ?? null,
                    completedAt: new Date(),
                    errorMessage: null,
                },
            })
            .catch((e) => console.warn("[ai] failed to finalize ai_run", e));

        return {
            reply: result.reply,
            sources: result.sources,
            model: result.model,
            runId: result.runId,
            answerMode: result.answerMode,
            groundingLabel: result.groundingLabel,
            searchMode: result.searchMode ?? null,
        };
    }
}

export const aiOrchestrator = new AiOrchestrator();

/** Exported for unit tests */
export const _aiOrchestratorTestUtils = {
    detectIntent,
    NOT_FOUND_LINE,
    GROUNDED_SYSTEM,
    GENERAL_SYSTEM,
};

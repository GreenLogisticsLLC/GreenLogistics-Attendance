import { collectCommandCenterCandidates } from "./collectors.js";
import { dedupeOperationalItems, documentDedupeKey } from "./dedupe.js";
import {
    determineOperationalPriority,
    sortOperationalItems,
} from "./priority.js";
import {
    buildDeterministicDailySummary,
    formatCommandCenterForChat,
} from "./format.js";
import type {
    ActionDisplayState,
    AiOperationalCategory,
    AiOperationalItem,
    AiOperationalPriority,
    CommandCenterActor,
    CommandCenterQuery,
    CommandCenterResult,
} from "./types.js";
import type { AiActionPublicView } from "../actions/types.js";

const PRIORITIES: AiOperationalPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

function enabled(): boolean {
    return String(process.env.AI_COMMAND_CENTER_ENABLED ?? "true").toLowerCase() !== "false";
}

function countsOf(items: AiOperationalItem[]): Record<AiOperationalPriority, number> {
    return Object.fromEntries(
        PRIORITIES.map((priority) => [
            priority,
            items.filter((item) => item.priority === priority).length,
        ])
    ) as Record<AiOperationalPriority, number>;
}

function categoryCountsOf(items: AiOperationalItem[]): Partial<Record<AiOperationalCategory, number>> {
    const counts: Partial<Record<AiOperationalCategory, number>> = {};
    for (const item of items) counts[item.category] = (counts[item.category] || 0) + 1;
    return counts;
}

function actionDisplayStateOf(action?: AiActionPublicView | null): ActionDisplayState {
    if (!action) return "NO_ACTION";
    if (action.status === "PENDING_CONFIRMATION") return "PENDING_CONFIRMATION";
    if (action.status === "EXECUTED" || action.status === "ALREADY_EXECUTED") return "EXECUTED";
    if (action.status === "FAILED") return "FAILED";
    if (action.status === "CANCELLED") return "CANCELLED";
    if (action.status === "EXPIRED") return "EXPIRED";
    return "RECOMMENDATION";
}

export class CommandCenterService {
    async getAttention(
        actor: CommandCenterActor,
        query: CommandCenterQuery = {}
    ): Promise<CommandCenterResult> {
        const generatedAt = new Date().toISOString();
        const marketProviders = {
            internal: "AVAILABLE" as const,
            dat: "NOT_CONNECTED" as const,
            truckstop: "NOT_CONNECTED" as const,
        };
        if (!enabled()) {
            return {
                items: [],
                counts: countsOf([]),
                categoryCounts: {},
                generatedAt,
                incomplete: [],
                summaryHints: {
                    total: 0,
                    requiringAction: 0,
                    blocking: 0,
                    topPriority: null,
                },
                marketProviders,
                message: "AI Command Center is disabled.",
            };
        }

        const collected = await collectCommandCenterCandidates(actor, query.myWork === true);
        let items = sortOperationalItems(dedupeOperationalItems(collected.items));
        if (query.priority) items = items.filter((item) => item.priority === query.priority);
        if (query.category) items = items.filter((item) => item.category === query.category);
        if (query.entityType) items = items.filter((item) => item.entityType === query.entityType);
        if (query.entityId) items = items.filter((item) => item.entityId === query.entityId);

        const counts = countsOf(items);
        const categoryCounts = categoryCountsOf(items);
        const total = items.length;
        const offset = Math.max(0, Number(query.offset) || 0);
        const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
        const sources = dedupeOperationalItems(items).flatMap((item) => item.sources);
        return {
            items: items.slice(offset, offset + limit),
            counts,
            categoryCounts,
            generatedAt,
            sources,
            incomplete: collected.incomplete,
            summaryHints: {
                total,
                requiringAction: items.filter((item) => item.nextBestAction !== "NO_ACTION").length,
                blocking: items.filter((item) => item.blocking).length,
                topPriority: items[0]?.priority || null,
            },
            marketProviders,
            actionsRequireConfirmation: true,
        };
    }

    formatForChat(result: CommandCenterResult): string {
        return formatCommandCenterForChat(result);
    }

    buildDailySummary(result: CommandCenterResult) {
        return buildDeterministicDailySummary(result);
    }
}

export const commandCenterService = new CommandCenterService();

export const _commandCenterTestUtils = {
    determineOperationalPriority,
    dedupeOperationalItems,
    sortOperationalItems,
    documentDedupeKey,
    countsOf,
    categoryCountsOf,
    actionDisplayStateOf,
    buildDeterministicDailySummary,
};

import type { OperationalPriority, OperationalRecommendation } from "./types.js";

export function recommendation(
    id: string,
    text: string,
    reason: string,
    priority: OperationalPriority,
    source?: string
): OperationalRecommendation {
    return {
        id,
        label: "RECOMMENDATION",
        text,
        reason,
        priority,
        source,
        humanConfirmationRequired: true,
    };
}

export function prioritizeRecommendations(
    items: OperationalRecommendation[]
): OperationalRecommendation[] {
    const order: Record<OperationalPriority, number> = {
        CRITICAL: 0,
        HIGH: 1,
        MEDIUM: 2,
        LOW: 3,
    };
    return [...items].sort((a, b) => order[a.priority] - order[b.priority]);
}

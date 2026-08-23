import type { CommandCenterResult } from "./types.js";

export function formatCommandCenterForChat(result: CommandCenterResult): string {
    if (!result.items.length) return "Nothing requiring attention was found.";
    const counts = result.counts;
    const lines = [
        `Attention: ${result.summaryHints?.total ?? result.items.length} items — ${counts.CRITICAL} critical, ${counts.HIGH} high, ${counts.MEDIUM} medium.`,
        "",
        "Top priorities:",
    ];
    result.items.slice(0, 8).forEach((item, index) => {
        lines.push(
            `${index + 1}. [${item.priority}] ${item.title}${item.entityLabel ? ` — ${item.entityLabel}` : ""}`
        );
        lines.push(`   ${item.reason}`);
    });
    lines.push("");
    lines.push("Recommendations are not executed automatically.");
    return lines.join("\n");
}

export function buildDeterministicDailySummary(result: CommandCenterResult) {
    const critical = result.counts.CRITICAL;
    const high = result.counts.HIGH;
    const recommendedFocus =
        critical > 0
            ? "Resolve critical shipment and compliance blockers first."
            : high > 0
              ? "Review high-priority operational blockers."
              : result.items.length
                ? "Work through medium-priority follow-ups and reviews."
                : "No operational attention is currently required.";
    return {
        summary: result.items.length
            ? `${result.summaryHints?.total ?? result.items.length} operational items require attention: ${critical} critical and ${high} high priority.`
            : "Nothing requiring attention was found.",
        topIssues: result.items.slice(0, 5),
        recommendedFocus,
        counts: result.counts,
        generatedAt: result.generatedAt,
    };
}

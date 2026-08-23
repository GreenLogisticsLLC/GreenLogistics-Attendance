import type { AiOperationalItem } from "./types.js";
import { PRIORITY_ORDER } from "./priority.js";

function uniqueSources(items: AiOperationalItem[]) {
    const seen = new Set<string>();
    return items.flatMap((item) => item.sources).filter((source) => {
        const key = `${source.type}:${source.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Consolidate one operational issue and retain its strongest priority. */
export function dedupeOperationalItems(items: AiOperationalItem[]): AiOperationalItem[] {
    const groups = new Map<string, AiOperationalItem[]>();
    for (const item of items) {
        const group = groups.get(item.dedupeKey) || [];
        group.push(item);
        groups.set(item.dedupeKey, group);
    }
    return [...groups.values()].map((group) => {
        const strongest = [...group].sort(
            (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
        )[0];
        const summaries = [...new Set(group.map((item) => item.summary).filter(Boolean))];
        const reasons = [...new Set(group.map((item) => item.reason).filter(Boolean))];
        return {
            ...strongest,
            summary: summaries.join(" · "),
            reason: reasons.join(" · "),
            blocking: group.some((item) => item.blocking),
            sources: uniqueSources(group),
        };
    });
}

export function documentDedupeKey(
    entityType: "carrier" | "shipment",
    entityId: string,
    documentType: string
): string {
    const normalized = String(documentType || "UNKNOWN")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_");
    return `${entityType}:${entityId}:${entityType === "shipment" && normalized === "POD" ? "pod" : "doc"}:${normalized}`;
}

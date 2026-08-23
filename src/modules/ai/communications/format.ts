import type { CommunicationContext } from "./types.js";

export function formatCommunicationForChat(ctx: CommunicationContext): string {
    const requested = ctx.openRequests.length
        ? ctx.openRequests
              .map(
                  (r) =>
                      `${r.documentType || r.requestType} — ${r.lifecycle} (${r.requestedAt || "timestamp unavailable"})`
              )
              .join("; ")
        : "None";
    const last = ctx.lastContact
        ? `${ctx.lastContact.at} · ${ctx.lastContact.direction} · ${ctx.lastContact.subject || "No subject"}`
        : "No linked contact";
    const next = ctx.recommendations[0]
        ? `[${ctx.recommendations[0].priority}] ${ctx.recommendations[0].text}`
        : "No communication action recommended";
    const sources = ctx.sources.length
        ? ctx.sources.slice(0, 12).map((s) => `${s.type}:${s.id}`).join(", ")
        : "None";
    return [
        `Communication Status: ${ctx.communicationStatus}`,
        `Waiting for: ${ctx.waitingFor}${ctx.waitingSince ? ` since ${ctx.waitingSince}` : ""}`,
        `Requested: ${requested}`,
        `Last contact: ${last}`,
        `Response: ${ctx.latestResponse}`,
        `Recommended next step: ${next}`,
        "Action: PENDING_CONFIRMATION if proposed — no action is executed without explicit confirmation.",
        `Sources: ${sources}`,
    ].join("\n");
}

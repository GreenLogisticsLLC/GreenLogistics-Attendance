import type { Direction } from "./types.js";

function normalizeAddress(value: string): string {
    const match = String(value || "").toLowerCase().match(/<([^>]+)>/);
    return (match?.[1] || value || "").trim().toLowerCase();
}

export function classifyDirection(
    fromAddress: string,
    ctx: {
        brokerEmails: Set<string>;
        carrierEmails: Set<string>;
        customerEmails: Set<string>;
    }
): Direction {
    const from = normalizeAddress(fromAddress);
    const has = (set: Set<string>) =>
        Array.from(set).some((email) => normalizeAddress(email) === from);
    if (has(ctx.brokerEmails)) return "OUTBOUND";
    if (has(ctx.carrierEmails) || has(ctx.customerEmails)) return "INBOUND";
    // Broker mailbox records are normally received mail; unknown participants remain inbound.
    return "INBOUND";
}

export function communicationParticipant(
    fromAddress: string,
    ctx: {
        brokerEmails: Set<string>;
        carrierEmails: Set<string>;
        customerEmails: Set<string>;
    }
): { participant: "BROKER" | "CARRIER" | "CUSTOMER" | "UNKNOWN"; uncertain: boolean } {
    const from = normalizeAddress(fromAddress);
    const has = (set: Set<string>) =>
        Array.from(set).some((email) => normalizeAddress(email) === from);
    if (has(ctx.brokerEmails)) return { participant: "BROKER", uncertain: false };
    if (has(ctx.carrierEmails)) return { participant: "CARRIER", uncertain: false };
    if (has(ctx.customerEmails)) return { participant: "CUSTOMER", uncertain: false };
    return { participant: "UNKNOWN", uncertain: true };
}

import {
    buildCarrierOperationalSummary,
    type OperationalActor,
} from "./carrier-context.js";
import { buildShipmentOperationalSummary } from "./shipment-context.js";
import type { CarrierOperationalSummary, ShipmentOperationalSummary } from "./types.js";

/**
 * Phase 4 operational facade — read-only analyze/recommend.
 */
export class OperationalAiService {
    async carrierSummary(actor: OperationalActor, carrierId: string): Promise<CarrierOperationalSummary> {
        return buildCarrierOperationalSummary(actor, carrierId);
    }

    async shipmentSummary(
        actor: OperationalActor,
        shipmentLeadId: string
    ): Promise<ShipmentOperationalSummary> {
        return buildShipmentOperationalSummary(actor, shipmentLeadId);
    }
}

export const operationalAiService = new OperationalAiService();

/** Format carrier summary for chat (structured, not long prose). */
export function formatCarrierSummaryForChat(s: CarrierOperationalSummary): string {
    const lines: string[] = [];
    lines.push(`Carrier: ${s.carrier.legalName}`);
    lines.push(`MC: ${s.carrier.mcNumber || "—"} · DOT: ${s.carrier.dotNumber || "—"}`);
    lines.push("");
    lines.push(`Readiness: ${s.readiness}`);
    lines.push(`Compliance: ${s.compliance.light}`);
    lines.push(s.compliance.summary);
    lines.push("");
    lines.push("Documents:");
    for (const d of s.documents) {
        lines.push(`- ${d.slot} — ${d.status}${d.reason ? ` (${d.reason})` : ""}`);
    }
    if (s.reviewItems.length) {
        lines.push("");
        lines.push("Problems:");
        s.reviewItems.slice(0, 8).forEach((r, i) => lines.push(`${i + 1}. ${r}`));
    }
    if (s.mismatches.length) {
        lines.push("");
        lines.push("Cross-document:");
        for (const m of s.mismatches) lines.push(`- ${m.message}`);
    }
    if (s.nextBestActions.length) {
        lines.push("");
        lines.push("Recommended next steps (RECOMMENDATION — not executed):");
        s.nextBestActions.forEach((a, i) =>
            lines.push(`${i + 1}. [${a.priority}] ${a.text} — ${a.reason}`)
        );
    }
    return lines.join("\n");
}

export function formatShipmentSummaryForChat(s: ShipmentOperationalSummary): string {
    const lines: string[] = [];
    lines.push(`Shipment: ${s.shipment.loadNumber || s.shipment.shipmentLeadId}`);
    lines.push(`Status: ${s.shipment.status}`);
    lines.push(`Lane: ${s.shipment.origin || "—"} → ${s.shipment.destination || "—"}`);
    lines.push(`Carrier: ${s.shipment.carrierName || s.carrier?.legalName || "—"}`);
    lines.push("");
    lines.push(`Readiness: ${s.readiness}`);
    lines.push("");
    lines.push("Documents:");
    for (const d of s.documents) {
        lines.push(`- ${d.slot} — ${d.status}${d.reason ? ` (${d.reason})` : ""}`);
    }
    if (s.reviewItems.length) {
        lines.push("");
        lines.push("Problems:");
        s.reviewItems.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
    }
    if (s.timeline.length) {
        lines.push("");
        lines.push("Timeline:");
        for (const t of s.timeline.slice(-12)) {
            lines.push(`- ${t.at.slice(0, 16)} — ${t.title}`);
        }
    }
    if (s.emails.length) {
        lines.push("");
        lines.push("Emails:");
        for (const e of s.emails.slice(0, 5)) {
            lines.push(`- ${e.at.slice(0, 10)} ${e.from}: ${e.subject}`);
        }
    }
    if (s.nextBestActions.length) {
        lines.push("");
        lines.push("Recommended next steps (RECOMMENDATION — not executed):");
        s.nextBestActions.forEach((a, i) =>
            lines.push(`${i + 1}. [${a.priority}] ${a.text}`)
        );
    }
    if (s.incompleteContext.length) {
        lines.push("");
        lines.push("Incomplete context:");
        s.incompleteContext.forEach((x) => lines.push(`- ${x}`));
    }
    return lines.join("\n");
}

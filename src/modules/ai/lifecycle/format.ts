import type { ShipmentLifecycleContext } from "./types.js";

export function formatShipmentLifecycleForChat(context: ShipmentLifecycleContext): string {
    const lines = [
        `Shipment lifecycle: ${context.loadNumber || context.shipmentId}`,
        `Stage: ${context.currentStage} (${context.stageStatus})`,
        `Health: ${context.lifecycleHealth}`,
        `Closeout readiness: ${context.closeoutReadiness}`,
    ];
    if (context.blockers.length) {
        lines.push("", "Blockers:");
        context.blockers.forEach((issue) => lines.push(`- ${issue.message}`));
    }
    if (context.warnings.length) {
        lines.push("", "Warnings:");
        context.warnings.slice(0, 8).forEach((issue) => lines.push(`- ${issue.message}`));
    }
    lines.push(
        "",
        `Next best action: ${context.nextBestAction}${
            context.nextBestAction === "CLOSE_SHIPMENT_MANUALLY"
                ? " (recommendation only — not executed)"
                : ""
        }`
    );
    if (context.communication) {
        lines.push(`Waiting for: ${context.communication.waitingFor}`);
    }
    if (context.incompleteSubsystems.length) {
        lines.push("", `Incomplete context: ${context.incompleteSubsystems.join(", ")}`);
    }
    lines.push("", context.groundingLabel);
    return lines.join("\n");
}

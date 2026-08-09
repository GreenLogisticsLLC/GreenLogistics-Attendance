import { config } from "../../config/env.js";
import { trackingService } from "./services/tracking.service.js";

let timer: ReturnType<typeof setInterval> | null = null;

export function startCarrierViewReconciliation() {
    if (timer) return;
    if (!config.carrierView.enabled) {
        console.log("[CARRIERVIEW_RECONCILIATION] disabled (CARRIER_VIEW_ENABLED=false)");
        return;
    }
    const sec = Math.max(60, config.carrierView.reconciliationIntervalSeconds || 300);
    console.log(`[CARRIERVIEW_RECONCILIATION] interval=${sec}s`);
    timer = setInterval(() => {
        trackingService.reconcileActive().catch((err) => {
            console.warn("[CARRIERVIEW_RECONCILIATION] tick failed", err);
        });
    }, sec * 1000);
}

import { carrierViewProvider } from "./providers/carrier-view/provider.js";
import type { TrackingProvider, TrackingProviderId } from "./types.js";

const providers: Record<string, TrackingProvider> = {
    carrier_view: carrierViewProvider,
};

export function getTrackingProvider(id: TrackingProviderId | string = "carrier_view"): TrackingProvider {
    const p = providers[id];
    if (!p) {
        throw Object.assign(new Error(`Tracking provider not implemented: ${id}`), { status: 501 });
    }
    return p;
}

export function listTrackingProviders(): TrackingProviderId[] {
    return Object.keys(providers) as TrackingProviderId[];
}

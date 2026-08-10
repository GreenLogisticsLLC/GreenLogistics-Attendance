import { createHash } from "crypto";
import type {
    NormalizedPosition,
    NormalizedTrackingLoad,
    TrackingLocationInput,
    TrackingProviderId,
} from "../../types.js";

export const CARRIER_VIEW_PROVIDER: TrackingProviderId = "carrier_view";

export function fingerprintPosition(input: {
    providerLoadId: string;
    latitude: number;
    longitude: number;
    timestamp?: string | null;
    movementType?: string | null;
}): string {
    const raw = [
        input.providerLoadId,
        Number(input.latitude).toFixed(6),
        Number(input.longitude).toFixed(6),
        input.timestamp || "",
        input.movementType || "",
    ].join("|");
    return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

export function fingerprintEvent(parts: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function normalizeCarrierViewPosition(
    position: Record<string, unknown> | null | undefined,
    meta: { shipmentId: string; providerLoadId: string }
): NormalizedPosition | null {
    if (!position) return null;
    const lat = Number(position.latitude);
    const lng = Number(position.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
        shipmentId: meta.shipmentId,
        provider: CARRIER_VIEW_PROVIDER,
        providerLoadId: String(meta.providerLoadId),
        driverPhone: position.driver_phone != null ? String(position.driver_phone) : null,
        latitude: lat,
        longitude: lng,
        address: position.address != null ? String(position.address) : null,
        movementType: position.type != null ? String(position.type) : null,
        rotation: position.rotation != null && Number.isFinite(Number(position.rotation))
            ? Number(position.rotation)
            : null,
        lateSeconds: position.late_secs != null ? Number(position.late_secs) : null,
        stoppedDuration: position.stopped_duration != null ? Number(position.stopped_duration) : null,
        driveDuration: position.drive_duration != null ? Number(position.drive_duration) : null,
        pausedDuration: position.paused_duration != null ? Number(position.paused_duration) : null,
        timestamp:
            position.created_at_utc != null
                ? String(position.created_at_utc)
                : position.created_at != null
                  ? String(position.created_at)
                  : null,
    };
}

export function normalizeCarrierViewLoad(
    load: Record<string, unknown>,
    shipmentId?: string
): NormalizedTrackingLoad {
    const providerLoadId = String(load.id ?? "");
    const last =
        load.last_position && typeof load.last_position === "object"
            ? normalizeCarrierViewPosition(load.last_position as Record<string, unknown>, {
                  shipmentId: shipmentId || "",
                  providerLoadId,
              })
            : null;

    return {
        provider: CARRIER_VIEW_PROVIDER,
        providerLoadId,
        externalLoadRef: load.load_id != null ? String(load.load_id) : null,
        driverPhone: load.driver_phone != null ? String(load.driver_phone) : null,
        trackingUrl:
            load.tracking_number_url != null
                ? String(load.tracking_number_url)
                : load.tracking_url != null
                  ? String(load.tracking_url)
                  : null,
        clientTrackingUrl: load.client_url != null ? String(load.client_url) : null,
        routeStarted: Boolean(load.route_started),
        driverIsLate: Boolean(load.driver_is_late),
        timeLeftSec: load.time_left_sec != null ? Number(load.time_left_sec) : null,
        distanceLeftMeters:
            load.distance_left_meters != null ? Number(load.distance_left_meters) : null,
        driverAppStatus: load.track_driver != null ? String(load.track_driver) : null,
        lastPosition: last,
        locations: load.locations ?? null,
        statuses: load.statuses ?? null,
        raw: load,
    };
}

export function toCarrierViewCreateBody(input: {
    driverPhone: string;
    externalLoadRef: string;
    locations: TrackingLocationInput[];
    startsActiveMinutes?: number;
    emails?: string[];
    dispatchers?: string[];
}) {
    return {
        integration_type: "carrier_view",
        driver_phone: input.driverPhone,
        load_id: input.externalLoadRef,
        locations: input.locations.map((loc) => {
            const row: Record<string, unknown> = {
                address: loc.address,
                company: loc.company || "",
                comment: loc.comment || "",
                type: loc.type,
            };
            // CarrierView requires dateFrom; never send empty strings.
            if (loc.dateFrom) row.dateFrom = loc.dateFrom;
            if (loc.dateTo) row.dateTo = loc.dateTo;
            return row;
        }),
        starts_active: input.startsActiveMinutes ?? 60,
        emails: input.emails ?? [],
        dispatchers: input.dispatchers ?? [],
    };
}

/** Build PATCH carefully — omitted emails/dispatchers wipe them on CarrierView. */
export function toCarrierViewPatchBody(input: {
    mcNumber?: string | null;
    emails?: string[];
    dispatchers?: string[];
    locations?: TrackingLocationInput[];
    includeEmails: boolean;
    includeDispatchers: boolean;
    includeLocations: boolean;
}) {
    const body: Record<string, unknown> = {};
    if (input.mcNumber !== undefined) body.mc_number = input.mcNumber;
    if (input.includeEmails) body.emails = input.emails ?? [];
    if (input.includeDispatchers) body.dispatchers = input.dispatchers ?? [];
    if (input.includeLocations && input.locations) {
        body.locations = input.locations.map((loc) => {
            const row: Record<string, unknown> = {};
            if (loc.id != null) row.id = loc.id;
            if (loc.address != null) row.address = loc.address;
            if (loc.company != null) row.company = loc.company;
            if (loc.comment != null) row.comment = loc.comment;
            if (loc.type != null) row.type = loc.type;
            if (loc.dateFrom != null) row.dateFrom = loc.dateFrom;
            if (loc.dateTo != null) row.dateTo = loc.dateTo;
            return row;
        });
    }
    return body;
}

export function formatCvDate(d?: Date | string | null): string | null {
    if (!d) return null;
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

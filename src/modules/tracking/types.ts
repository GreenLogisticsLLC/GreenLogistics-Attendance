/**
 * Provider-agnostic GPS tracking contracts.
 * Green OS core uses these; CarrierView/Motive/Samsara adapters map to them.
 */

export type TrackingProviderId = "carrier_view" | "motive" | "samsara" | "verizon";

export type TrackingSessionStatus = "ACTIVE" | "DISABLED" | "DELETED" | "ERROR";

export interface TrackingLocationInput {
    address: string;
    company?: string | null;
    comment?: string | null;
    type: "pickup" | "destination" | string;
    dateFrom?: string | null;
    dateTo?: string | null;
    /** Provider location id — required for PATCH location edits. */
    id?: number | string | null;
}

export interface CreateTrackingLoadInput {
    shipmentLeadId: string;
    externalLoadRef: string;
    driverPhone: string;
    locations: TrackingLocationInput[];
    startsActiveMinutes?: number;
    emails?: string[];
    dispatchers?: string[];
    mcNumber?: string | null;
    vehicleCompanyId?: string | null;
}

export interface NormalizedPosition {
    shipmentId: string;
    provider: TrackingProviderId;
    providerLoadId: string;
    driverPhone: string | null;
    latitude: number;
    longitude: number;
    address: string | null;
    movementType: string | null;
    rotation: number | null;
    lateSeconds: number | null;
    stoppedDuration: number | null;
    driveDuration: number | null;
    pausedDuration: number | null;
    timestamp: string | null;
}

export interface NormalizedTrackingLoad {
    provider: TrackingProviderId;
    providerLoadId: string;
    externalLoadRef: string | null;
    driverPhone: string | null;
    trackingUrl: string | null;
    clientTrackingUrl: string | null;
    routeStarted: boolean;
    driverIsLate: boolean;
    timeLeftSec: number | null;
    distanceLeftMeters: number | null;
    driverAppStatus: string | null;
    lastPosition: NormalizedPosition | null;
    locations: unknown;
    statuses: unknown;
    raw?: unknown;
}

export interface EditTrackingLoadInput {
    providerLoadId: string;
    mcNumber?: string | null;
    /** Omit to leave emails untouched; pass [] only when intentional clear is desired. */
    emails?: string[] | undefined;
    dispatchers?: string[] | undefined;
    locations?: TrackingLocationInput[] | undefined;
}

export interface SendSmsInput {
    providerLoadId: string;
    type: "welcome" | "assigned_load" | "one_time_ping_request" | "installation_guide" | "custom";
    message?: string;
}

export interface TrackingProvider {
    readonly id: TrackingProviderId;
    createLoad(input: CreateTrackingLoadInput): Promise<NormalizedTrackingLoad>;
    getLoad(providerLoadId: string): Promise<NormalizedTrackingLoad>;
    updateLoad(input: EditTrackingLoadInput): Promise<NormalizedTrackingLoad>;
    disableLoad(providerLoadId: string): Promise<void>;
    getLastPosition(providerLoadId: string, shipmentId: string): Promise<NormalizedPosition | null>;
    getPositionHistory(
        providerLoadId: string,
        shipmentId: string,
        opts?: { page?: number; perPage?: number; order?: "asc" | "desc" }
    ): Promise<NormalizedPosition[]>;
    sendDriverMessage(providerLoadId: string, message: string): Promise<void>;
    sendDriverSms(input: SendSmsInput): Promise<void>;
}

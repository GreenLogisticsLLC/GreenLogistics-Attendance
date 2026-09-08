/** Normalize carrier identity fields for change detection. */
export function normEmail(v: string | null | undefined): string {
    return String(v || "")
        .trim()
        .toLowerCase();
}

export function normMc(v: string | null | undefined): string {
    return String(v || "")
        .trim()
        .toUpperCase()
        .replace(/^MC\s*/i, "")
        .replace(/[^A-Z0-9]/g, "");
}

export function normName(v: string | null | undefined): string {
    return String(v || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

/**
 * Same physical carrier registration (not a carrier change).
 * Name/email/MC must all match; empty MC is allowed on both sides.
 */
export function isSameCarrierIdentity(
    a: { email?: string | null; legalName?: string | null; mcNumber?: string | null },
    b: { email?: string | null; legalName?: string | null; mcNumber?: string | null }
): boolean {
    const emailA = normEmail(a.email);
    const emailB = normEmail(b.email);
    if (!emailA || !emailB || emailA !== emailB) return false;
    if (normName(a.legalName) !== normName(b.legalName)) return false;
    return normMc(a.mcNumber) === normMc(b.mcNumber);
}

/**
 * Decide whether a carrier row should show as superseded (red) on the Carriers list.
 * Official load carrier = ShipmentLead.carrierProfileId (latest registration for that load).
 */
export function computeCarrierSuperseded(input: {
    carrierId: string;
    createdAt: Date | string;
    mcNumber?: string | null;
    assignedBrokerId?: string | null;
    /** Loads where this carrier is currently the official profile. */
    officialOnLoadIds: string[];
    /** Loads this carrier was registered/onboarded for (sessions/events). */
    linkedLoadIds: string[];
    /** loadId → current official carrierProfileId */
    officialByLoad: Record<string, string | null | undefined>;
    /** Peers sharing same MC + broker (including self). */
    mcPeers: Array<{
        carrierId: string;
        createdAt: Date | string;
        isOfficialOnAnyLoad: boolean;
    }>;
}): { isSuperseded: boolean; isOfficialLoadCarrier: boolean; reason: string | null } {
    const isOfficialLoadCarrier = input.officialOnLoadIds.length > 0;
    if (isOfficialLoadCarrier) {
        return { isSuperseded: false, isOfficialLoadCarrier: true, reason: null };
    }

    for (const loadId of input.linkedLoadIds) {
        const official = input.officialByLoad[loadId];
        if (official && official !== input.carrierId) {
            return {
                isSuperseded: true,
                isOfficialLoadCarrier: false,
                reason: "replaced_on_load",
            };
        }
    }

    const mc = normMc(input.mcNumber);
    if (mc && input.mcPeers.length > 1) {
        const selfTime = new Date(input.createdAt).getTime();
        const newerOfficialPeer = input.mcPeers.some(
            (p) =>
                p.carrierId !== input.carrierId &&
                p.isOfficialOnAnyLoad &&
                new Date(p.createdAt).getTime() >= selfTime
        );
        if (newerOfficialPeer) {
            return {
                isSuperseded: true,
                isOfficialLoadCarrier: false,
                reason: "replaced_by_newer_mc_peer",
            };
        }

        // Last registered under this MC/broker is the working carrier; older registrations are red.
        const hasNewerPeer = input.mcPeers.some(
            (p) =>
                p.carrierId !== input.carrierId &&
                new Date(p.createdAt).getTime() > selfTime
        );
        if (hasNewerPeer) {
            return {
                isSuperseded: true,
                isOfficialLoadCarrier: false,
                reason: "older_registration",
            };
        }
    }

    return { isSuperseded: false, isOfficialLoadCarrier: false, reason: null };
}

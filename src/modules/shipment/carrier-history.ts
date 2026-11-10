export type CarrierHistoryEntry = {
    carrierName: string | null;
    carrierEmail: string | null;
    carrierPhone: string | null;
    carrierMc: string | null;
    carrierDot: string | null;
    carrierProfileId: string | null;
    carrierRate: number | null;
    replacedAt: string;
    reason: string;
};

export function parseCarrierHistory(raw: string | null | undefined): CarrierHistoryEntry[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((row) => row && typeof row === "object")
            .map((row) => {
                const r = row as Record<string, unknown>;
                return {
                    carrierName: r.carrierName == null ? null : String(r.carrierName),
                    carrierEmail: r.carrierEmail == null ? null : String(r.carrierEmail),
                    carrierPhone: r.carrierPhone == null ? null : String(r.carrierPhone),
                    carrierMc: r.carrierMc == null ? null : String(r.carrierMc),
                    carrierDot: r.carrierDot == null ? null : String(r.carrierDot),
                    carrierProfileId:
                        r.carrierProfileId == null ? null : String(r.carrierProfileId),
                    carrierRate:
                        r.carrierRate == null || r.carrierRate === ""
                            ? null
                            : Number(r.carrierRate),
                    replacedAt: String(r.replacedAt || new Date().toISOString()),
                    reason: String(r.reason || "carrier_change"),
                };
            });
    } catch {
        return [];
    }
}

export function appendCarrierHistory(
    raw: string | null | undefined,
    entry: Omit<CarrierHistoryEntry, "replacedAt"> & { replacedAt?: string }
): string {
    const history = parseCarrierHistory(raw);
    history.push({
        ...entry,
        replacedAt: entry.replacedAt || new Date().toISOString(),
    });
    // Keep the last 20 replacements on the load number.
    return JSON.stringify(history.slice(-20));
}

/** Status to restore when a broker reactivates a voided load. */
export function statusAfterUnvoid(statusBeforeVoid: string | null | undefined): string {
    const normalized = String(statusBeforeVoid || "")
        .trim()
        .toUpperCase();
    if (
        !normalized ||
        normalized === "VOIDED" ||
        normalized === "NEW" ||
        normalized === "UNASSIGNED"
    ) {
        return "CARRIER_ASSIGNED";
    }
    return normalized;
}

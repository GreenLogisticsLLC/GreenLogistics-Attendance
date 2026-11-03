/** Pickup day arrived and the load still has no carrier. */

const DONE = new Set([
    "COMPLETED",
    "CLOSED",
    "LOST",
    "DELETED_FROM_CUSTOMER",
    "ACCEPTED_ANOTHER_COMPANY",
]);

export function companyDateKey(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value || "0000";
    const month = parts.find((part) => part.type === "month")?.value || "01";
    const day = parts.find((part) => part.type === "day")?.value || "01";
    return `${year}-${month}-${day}`;
}

export function carrierMissingOnPickup(input: {
    loadNumber?: string | null;
    carrierName?: string | null;
    status?: string | null;
    pickupFrom?: Date | string | null;
    opsPickupAt?: Date | string | null;
    now?: Date;
    timeZone: string;
}): boolean {
    if (!String(input.loadNumber || "").trim()) return false;
    if (String(input.carrierName || "").trim()) return false;
    if (DONE.has(String(input.status || ""))) return false;
    const raw = input.opsPickupAt || input.pickupFrom;
    if (!raw) return false;
    const pickup = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(pickup.getTime())) return false;
    const today = companyDateKey(input.now || new Date(), input.timeZone);
    return companyDateKey(pickup, input.timeZone) <= today;
}

/** Team Lead of the broker, the broker when they are a Team Lead, and every Manager. */
export function carrierMissingRecipients(input: {
    brokerUserId?: string | null;
    brokerRole?: string | null;
    brokerTeamLeadId?: string | null;
    managerUserIds: string[];
}): string[] {
    const ids = new Set<string>();
    for (const id of input.managerUserIds) {
        if (id) ids.add(id);
    }
    if (input.brokerTeamLeadId) ids.add(input.brokerTeamLeadId);
    if (input.brokerRole === "Team Lead" && input.brokerUserId) ids.add(input.brokerUserId);
    return [...ids];
}

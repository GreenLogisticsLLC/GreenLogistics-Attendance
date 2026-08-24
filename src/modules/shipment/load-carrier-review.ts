export type CarrierReviewSource = "carrier_packet" | "prior_load";

export type CarrierReviewSlotKey =
    | "MC_AUTHORITY"
    | "W9"
    | "COI"
    | "BROKER_CARRIER_AGREEMENT"
    | "RATE_CONFIRMATION"
    | "BOL";

export type CarrierReviewDoc = {
    documentId: string;
    documentType: string;
    originalFilename?: string | null;
    uploadedAt?: Date | string | null;
    sourceLoadId?: string | null;
    sourceLoadNumber?: string | null;
};

export type CarrierReviewSlot = {
    key: CarrierReviewSlotKey;
    label: string;
    source: CarrierReviewSource;
    present: boolean;
    document: CarrierReviewDoc | null;
};

export const LOAD_CARRIER_REVIEW_SLOTS: Array<{
    key: CarrierReviewSlotKey;
    label: string;
    source: CarrierReviewSource;
    types: string[];
}> = [
    {
        key: "MC_AUTHORITY",
        label: "MC Authority",
        source: "carrier_packet",
        types: ["MC_AUTHORITY"],
    },
    { key: "W9", label: "W-9", source: "carrier_packet", types: ["W9"] },
    {
        key: "COI",
        label: "Certificate of Holder",
        source: "carrier_packet",
        types: ["COI", "INSURANCE"],
    },
    {
        key: "BROKER_CARRIER_AGREEMENT",
        label: "Broker–Carrier Agreement",
        source: "carrier_packet",
        types: ["BROKER_CARRIER_AGREEMENT"],
    },
    {
        key: "RATE_CONFIRMATION",
        label: "Rate Confirmation (previous load)",
        source: "prior_load",
        types: ["RATE_CONFIRMATION"],
    },
    {
        key: "BOL",
        label: "BOL (previous load)",
        source: "prior_load",
        types: ["BOL"],
    },
];

export function isLoadCarrierApproved(input: {
    carrierProfileId?: string | null;
    loadCarrierApprovedAt?: Date | string | null;
    loadCarrierApprovedProfileId?: string | null;
}): boolean {
    const profileId = String(input.carrierProfileId || "").trim();
    const approvedFor = String(input.loadCarrierApprovedProfileId || "").trim();
    return Boolean(input.loadCarrierApprovedAt && profileId && approvedFor === profileId);
}

export function pickLatestReviewDoc(
    docs: CarrierReviewDoc[],
    types: string[]
): CarrierReviewDoc | null {
    const want = new Set(types.map((t) => String(t || "").toUpperCase()));
    for (const doc of docs) {
        if (want.has(String(doc.documentType || "").toUpperCase())) return doc;
    }
    return null;
}

/**
 * Build the review checklist. Documents are references only — never copied onto the new load.
 */
export function buildCarrierReviewSlots(input: {
    packetDocs: CarrierReviewDoc[];
    priorLoadDocs: CarrierReviewDoc[];
}): CarrierReviewSlot[] {
    return LOAD_CARRIER_REVIEW_SLOTS.map((slot) => {
        const pool = slot.source === "prior_load" ? input.priorLoadDocs : input.packetDocs;
        const document = pickLatestReviewDoc(pool, slot.types);
        return {
            key: slot.key,
            label: slot.label,
            source: slot.source,
            present: Boolean(document),
            document,
        };
    });
}

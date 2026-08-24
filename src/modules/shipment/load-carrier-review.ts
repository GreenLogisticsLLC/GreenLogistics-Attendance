export type CarrierReviewSource = "carrier_packet";

export type CarrierReviewSlotKey =
    | "MC_AUTHORITY"
    | "W9"
    | "COI"
    | "BROKER_CARRIER_AGREEMENT";

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
];

/** Load RC/BOL belong only to the load that created them — never a carrier packet item. */
export const CARRIER_PACKET_EXCLUDE_DOC_TYPES = ["RATE_CONFIRMATION", "BOL", "POD"] as const;

export function isCarrierPacketExcluded(documentType: string): boolean {
    return (CARRIER_PACKET_EXCLUDE_DOC_TYPES as readonly string[]).includes(
        String(documentType || "").toUpperCase()
    );
}

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
 * Build the review checklist. Packet files only — never previous-load RC/BOL.
 */
export function buildCarrierReviewSlots(input: {
    packetDocs: CarrierReviewDoc[];
}): CarrierReviewSlot[] {
    const packetDocs = (input.packetDocs || []).filter(
        (doc) => !isCarrierPacketExcluded(doc.documentType)
    );
    return LOAD_CARRIER_REVIEW_SLOTS.map((slot) => {
        const document = pickLatestReviewDoc(packetDocs, slot.types);
        return {
            key: slot.key,
            label: slot.label,
            source: slot.source,
            present: Boolean(document),
            document,
        };
    });
}

import { prisma } from "../../../config/database.js";
import {
    buildCarrierReviewSlots,
    CARRIER_PACKET_EXCLUDE_DOC_TYPES,
    isCarrierPacketExcluded,
    type CarrierReviewDoc,
    type CarrierReviewSlot,
} from "../load-carrier-review.js";

/**
 * RC/BOL copies on the carrier profile must not appear on the next load.
 * They stay archived on the load that created them.
 */
export async function detachLoadDocsFromCarrierPacket(carrierId?: string | null) {
    await prisma.carrierDocument.updateMany({
        where: {
            ...(carrierId ? { carrierId } : {}),
            documentType: { in: [...CARRIER_PACKET_EXCLUDE_DOC_TYPES] },
            status: "CURRENT",
        },
        data: { status: "ARCHIVED" },
    });
}

export async function buildLoadCarrierReviewPacket(input: {
    currentShipmentLeadId: string;
    carrierProfileId?: string | null;
    carrierMc?: string | null;
    packetDocs: CarrierReviewDoc[];
}): Promise<CarrierReviewSlot[]> {
    await detachLoadDocsFromCarrierPacket();
    const packetDocs = (input.packetDocs || []).filter(
        (doc) => !isCarrierPacketExcluded(doc.documentType)
    );
    return buildCarrierReviewSlots({ packetDocs });
}

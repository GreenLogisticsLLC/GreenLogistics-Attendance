import { prisma } from "../../../config/database.js";
import {
    buildCarrierReviewSlots,
    type CarrierReviewDoc,
    type CarrierReviewSlot,
} from "../load-carrier-review.js";

function digits(value: string | null | undefined): string {
    return String(value || "").replace(/\D/g, "");
}

function toReviewDoc(
    row: {
        documentId: string;
        documentType?: string | null;
        docType?: string | null;
        originalFilename?: string | null;
        fileName?: string | null;
        uploadedAt?: Date | null;
        createdAt?: Date | null;
        shipmentLeadId?: string | null;
        loadNumber?: string | null;
    },
    extra?: { sourceLoadId?: string | null; sourceLoadNumber?: string | null }
): CarrierReviewDoc {
    return {
        documentId: row.documentId,
        documentType: String(row.documentType || row.docType || "").toUpperCase(),
        originalFilename: row.originalFilename || row.fileName || null,
        uploadedAt: row.uploadedAt || row.createdAt || null,
        sourceLoadId: extra?.sourceLoadId || row.shipmentLeadId || null,
        sourceLoadNumber: extra?.sourceLoadNumber || row.loadNumber || null,
    };
}

export async function listPriorLoadReviewDocs(input: {
    currentShipmentLeadId: string;
    carrierProfileId?: string | null;
    carrierMc?: string | null;
}): Promise<CarrierReviewDoc[]> {
    const mc = digits(input.carrierMc);
    const or: Array<Record<string, unknown>> = [];
    if (input.carrierProfileId) or.push({ carrierProfileId: input.carrierProfileId });
    if (mc) {
        or.push({ carrierMc: { contains: mc } });
    }
    if (!or.length) return [];

    const priorLoads = await prisma.shipmentLead.findMany({
        where: {
            shipmentLeadId: { not: input.currentShipmentLeadId },
            loadNumber: { not: null },
            OR: or,
        },
        select: { shipmentLeadId: true, loadNumber: true },
        orderBy: { updatedAt: "desc" },
        take: 25,
    });
    if (!priorLoads.length) return [];

    const byId = new Map(priorLoads.map((row) => [row.shipmentLeadId, row.loadNumber]));
    const docs = await prisma.loadDocument.findMany({
        where: {
            shipmentLeadId: { in: priorLoads.map((row) => row.shipmentLeadId) },
            isCurrent: true,
            status: { not: "ARCHIVED" },
            docType: { in: ["RATE_CONFIRMATION", "BOL"] },
        },
        select: {
            documentId: true,
            docType: true,
            fileName: true,
            createdAt: true,
            shipmentLeadId: true,
        },
        orderBy: { createdAt: "desc" },
    });

    return docs.map((row) =>
        toReviewDoc(row, {
            sourceLoadId: row.shipmentLeadId,
            sourceLoadNumber: byId.get(row.shipmentLeadId) || null,
        })
    );
}

export async function buildLoadCarrierReviewPacket(input: {
    currentShipmentLeadId: string;
    carrierProfileId?: string | null;
    carrierMc?: string | null;
    packetDocs: CarrierReviewDoc[];
}): Promise<CarrierReviewSlot[]> {
    const priorLoadDocs = await listPriorLoadReviewDocs({
        currentShipmentLeadId: input.currentShipmentLeadId,
        carrierProfileId: input.carrierProfileId,
        carrierMc: input.carrierMc,
    });
    return buildCarrierReviewSlots({
        packetDocs: input.packetDocs,
        priorLoadDocs,
    });
}

export async function getReferenceLoadDocument(input: {
    currentShipmentLeadId: string;
    documentId: string;
    carrierProfileId?: string | null;
    carrierMc?: string | null;
}) {
    const row = await prisma.loadDocument.findUnique({
        where: { documentId: input.documentId },
        include: {
            shipmentLead: {
                select: {
                    shipmentLeadId: true,
                    loadNumber: true,
                    carrierProfileId: true,
                    carrierMc: true,
                },
            },
        },
    });
    if (!row || row.shipmentLead.shipmentLeadId === input.currentShipmentLeadId) {
        throw Object.assign(new Error("Reference document not found"), { status: 404 });
    }
    const sameProfile =
        Boolean(input.carrierProfileId) &&
        row.shipmentLead.carrierProfileId === input.carrierProfileId;
    const currentMc = digits(input.carrierMc);
    const sameMc = Boolean(currentMc) && digits(row.shipmentLead.carrierMc) === currentMc;
    if (!sameProfile && !sameMc) {
        throw Object.assign(new Error("Reference document is not from this carrier"), {
            status: 403,
        });
    }
    if (!["RATE_CONFIRMATION", "BOL"].includes(String(row.docType || "").toUpperCase())) {
        throw Object.assign(new Error("Only previous Rate Confirmation and BOL can be opened here"), {
            status: 403,
        });
    }
    return row;
}

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { prisma } from "../../../config/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHIPMENT_UPLOADS_ROOT = path.join(__dirname, "..", "..", "..", "..", "uploads", "shipments");

export type ShipmentDocument = {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    storedName: string;
    url: string;
    uploadedAt: string;
    uploadedBy?: string;
};

function parseDocuments(raw: string | null | undefined): ShipmentDocument[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function safeFileName(name: string): string {
    return String(name || "file")
        .replace(/[^\w.\- ()[\]]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || "file";
}

export class ShipmentFilesService {
    ensureDir(shipmentLeadId: string) {
        const dir = path.join(SHIPMENT_UPLOADS_ROOT, shipmentLeadId);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    async list(shipmentLeadId: string): Promise<ShipmentDocument[]> {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { documentsJson: true },
        });
        return parseDocuments(lead?.documentsJson);
    }

    async attachUploadedFile(input: {
        shipmentLeadId: string;
        originalName: string;
        mimeType: string;
        size: number;
        tempPath: string;
        uploadedBy?: string;
    }): Promise<ShipmentDocument> {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
            select: { shipmentLeadId: true, documentsJson: true },
        });
        if (!lead) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }

        const id = randomUUID();
        const safe = safeFileName(input.originalName);
        const storedName = `${id}-${safe}`;
        const dir = this.ensureDir(input.shipmentLeadId);
        const dest = path.join(dir, storedName);
        fs.renameSync(input.tempPath, dest);

        const doc: ShipmentDocument = {
            id,
            name: input.originalName || safe,
            mimeType: input.mimeType || "application/octet-stream",
            size: input.size || 0,
            storedName,
            url: `/api/crm/shipments/${input.shipmentLeadId}/files/${id}`,
            uploadedAt: new Date().toISOString(),
            uploadedBy: input.uploadedBy,
        };

        const docs = [...parseDocuments(lead.documentsJson), doc];
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: input.shipmentLeadId },
            data: { documentsJson: JSON.stringify(docs) },
        });
        return doc;
    }

    async resolveFilePath(shipmentLeadId: string, fileId: string): Promise<{
        absolutePath: string;
        doc: ShipmentDocument;
    } | null> {
        const docs = await this.list(shipmentLeadId);
        const doc = docs.find((d) => d.id === fileId);
        if (!doc?.storedName) return null;
        const absolutePath = path.join(SHIPMENT_UPLOADS_ROOT, shipmentLeadId, doc.storedName);
        if (!fs.existsSync(absolutePath)) return null;
        return { absolutePath, doc };
    }

    async removeFile(shipmentLeadId: string, fileId: string): Promise<boolean> {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { documentsJson: true },
        });
        if (!lead) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }
        const docs = parseDocuments(lead.documentsJson);
        const doc = docs.find((d) => d.id === fileId);
        if (!doc) return false;

        const absolutePath = path.join(SHIPMENT_UPLOADS_ROOT, shipmentLeadId, doc.storedName);
        if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
        }

        const next = docs.filter((d) => d.id !== fileId);
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { documentsJson: JSON.stringify(next) },
        });
        return true;
    }
}

export const shipmentFilesService = new ShipmentFilesService();

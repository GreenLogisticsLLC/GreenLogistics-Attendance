import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "url";
import type { LoadDocType } from "../load.constants.js";
import { LOAD_DOC_TYPE_LABELS } from "../load.constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOAD_DOCS_ROOT = path.join(__dirname, "..", "..", "..", "uploads", "loads");

export type LoadDocumentContent = {
    loadNumber?: string | null;
    shipmentNumber?: string | null;
    referenceNumber?: string | null;
    customerName?: string | null;
    brokerName?: string | null;
    carrierName?: string | null;
    carrierMc?: string | null;
    carrierDot?: string | null;
    driverName?: string | null;
    truckNumber?: string | null;
    trailerNumber?: string | null;
    pickupAddress?: string | null;
    deliveryAddress?: string | null;
    pickupWindow?: string | null;
    deliveryWindow?: string | null;
    equipment?: string | null;
    commodity?: string | null;
    weight?: string | null;
    pieces?: string | number | null;
    miles?: string | number | null;
    customerRate?: string | number | null;
    carrierRate?: string | number | null;
    terms?: string | null;
    specialInstructions?: string | null;
    extraLines?: string[];
};

function money(v: string | number | null | undefined): string {
    if (v == null || v === "") return "—";
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(n)) return String(v);
    return `$${n.toFixed(2)}`;
}

function line(doc: PDFKit.PDFDocument, label: string, value: string | null | undefined) {
    doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
    doc.font("Helvetica").text(value && String(value).trim() ? String(value) : "—");
}

/**
 * Generate a load document PDF from template + editable content snapshot.
 * Files live under uploads/loads/{shipmentLeadId}/ — always attached to the Load.
 */
export async function generateLoadDocumentPdf(input: {
    shipmentLeadId: string;
    docType: LoadDocType | string;
    version: number;
    content: LoadDocumentContent;
}): Promise<{ storedName: string; fileUrl: string; fileName: string; mimeType: string; fileSize: number }> {
    const dir = path.join(LOAD_DOCS_ROOT, input.shipmentLeadId);
    fs.mkdirSync(dir, { recursive: true });

    const label = LOAD_DOC_TYPE_LABELS[input.docType] || input.docType;
    const fileName = `${label.replace(/\s+/g, "_")}_v${input.version}.pdf`;
    const storedName = `${input.docType}_v${input.version}_${Date.now()}.pdf`;
    const dest = path.join(dir, storedName);
    const c = input.content || {};

    await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: "LETTER" });
        const stream = fs.createWriteStream(dest);
        doc.pipe(stream);

        doc.fontSize(18).font("Helvetica-Bold").text("Green Logistics", { align: "left" });
        doc.fontSize(11).font("Helvetica").fillColor("#166534").text("GreenOS TMS", { align: "left" });
        doc.fillColor("#000000");
        doc.moveDown(0.5);
        doc.fontSize(16).font("Helvetica-Bold").text(label);
        doc.fontSize(10).font("Helvetica").text(`Version ${input.version}`);
        doc.moveDown();

        line(doc, "Load Number", c.loadNumber);
        line(doc, "Shipment Number", c.shipmentNumber);
        line(doc, "Reference", c.referenceNumber);
        doc.moveDown(0.4);
        line(doc, "Customer", c.customerName);
        line(doc, "Broker", c.brokerName);
        line(doc, "Carrier", c.carrierName);
        if (c.carrierMc) line(doc, "MC", c.carrierMc);
        if (c.carrierDot) line(doc, "DOT", c.carrierDot);
        if (c.driverName) line(doc, "Driver", c.driverName);
        if (c.truckNumber) line(doc, "Truck", c.truckNumber);
        if (c.trailerNumber) line(doc, "Trailer", c.trailerNumber);
        doc.moveDown(0.4);
        line(doc, "Pickup", c.pickupAddress);
        if (c.pickupWindow) line(doc, "Pickup Window", c.pickupWindow);
        line(doc, "Delivery", c.deliveryAddress);
        if (c.deliveryWindow) line(doc, "Delivery Window", c.deliveryWindow);
        doc.moveDown(0.4);
        line(doc, "Equipment", c.equipment);
        line(doc, "Commodity", c.commodity);
        line(doc, "Weight", c.weight);
        line(doc, "Pieces", c.pieces != null ? String(c.pieces) : null);
        line(doc, "Miles", c.miles != null ? String(c.miles) : null);
        doc.moveDown(0.4);

        if (input.docType === "RATE_CONFIRMATION" || input.docType === "CARRIER_INVOICE") {
            line(doc, "Carrier Rate", money(c.carrierRate));
        }
        if (input.docType === "CUSTOMER_INVOICE" || input.docType === "LOAD_SUMMARY") {
            line(doc, "Customer Rate", money(c.customerRate));
        }
        if (input.docType === "RATE_CONFIRMATION") {
            line(doc, "Customer Rate (broker)", money(c.customerRate));
        }

        if (c.terms) {
            doc.moveDown(0.6);
            doc.font("Helvetica-Bold").text("Terms");
            doc.font("Helvetica").text(String(c.terms), { width: 500 });
        }
        if (c.specialInstructions) {
            doc.moveDown(0.6);
            doc.font("Helvetica-Bold").text("Special Instructions");
            doc.font("Helvetica").text(String(c.specialInstructions), { width: 500 });
        }
        if (Array.isArray(c.extraLines) && c.extraLines.length) {
            doc.moveDown(0.6);
            for (const row of c.extraLines) doc.font("Helvetica").text(String(row));
        }

        doc.moveDown(1.2);
        doc.fontSize(8).fillColor("#666666").text(
            "This document belongs to the Load above. Generated by GreenOS — never a standalone file.",
            { align: "left" }
        );

        doc.end();
        stream.on("finish", () => resolve());
        stream.on("error", reject);
    });

    const stat = fs.statSync(dest);
    return {
        storedName,
        fileName,
        mimeType: "application/pdf",
        fileSize: stat.size,
        fileUrl: `/uploads/loads/${input.shipmentLeadId}/${storedName}`,
    };
}

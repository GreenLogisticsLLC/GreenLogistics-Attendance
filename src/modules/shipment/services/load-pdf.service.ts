import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "url";
import type { LoadDocType } from "../load.constants.js";
import { LOAD_DOC_TYPE_LABELS } from "../load.constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOAD_DOCS_ROOT = path.join(__dirname, "..", "..", "..", "uploads", "loads");

/** Company block matching the current Green Logistics Rate Confirmation. */
export const GREEN_LOGISTICS_RC = {
    legalName: "Green Logistics LLC",
    addressLine1: "121 Frog Hollow RD",
    addressLine2: "Churchville, PA 18966",
    mc: "1237784",
    dispatchPhone: "(267) 703-5313",
    billingEmails: ["greenlogisticsllc20@gmail.com", "info@greengrouplogistics.com"],
};

export const DEFAULT_RATE_CON_TERMS = [
    "Payment of detention is determined on a load-by-load basis. Unauthorized charges will not be paid. Detention payment does not begin for at least 2 hours unless otherwise agreed to in writing. Each hour pays $25 after checking in, max is $250.",
    "Layover starts to count if the total waiting time exceeds 12 hours after checking in. The standard rate applies for a total of $250.",
    "Late delivery fee is $500 per each day. Deductions for missed appointments and non macropoint acceptance will apply. Fee is $200.",
    "Truck Ordered Not Used pays $150. If the carrier picked up a partial load instead of the full load the deduction may apply. For the shipments with the rate less than $1000 TONU pays $100.",
    "If the shipment got damaged/scratched or the carrier picked up the shipment in damaged condition without confirming, the customer have the right to apply charges even if the damage was not mentioned on the BOL.",
    "This is a rate confirmation not a BOL. If you use this as BOL you may not be paid. Send the clear picture of POD after delivery within 24 hours. No pictures or dark images accepted.",
].join("\n\n");

export type LoadDocumentContent = {
    loadNumber?: string | null;
    shipmentNumber?: string | null;
    referenceNumber?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    brokerName?: string | null;
    /** Broker connected Gmail (or GreenOS login email). */
    brokerEmail?: string | null;
    carrierName?: string | null;
    carrierEmail?: string | null;
    carrierMc?: string | null;
    carrierDot?: string | null;
    carrierPhone?: string | null;
    driverName?: string | null;
    driverPhone?: string | null;
    truckNumber?: string | null;
    trailerNumber?: string | null;
    pickupAddress?: string | null;
    deliveryAddress?: string | null;
    pickupWindow?: string | null;
    deliveryWindow?: string | null;
    pickupDate?: string | null;
    pickupTime?: string | null;
    pickupContact?: string | null;
    deliveryDate?: string | null;
    deliveryTime?: string | null;
    deliveryContact?: string | null;
    equipment?: string | null;
    commodity?: string | null;
    weight?: string | null;
    pieces?: string | number | null;
    miles?: string | number | null;
    customerRate?: string | number | null;
    carrierRate?: string | number | null;
    flatRate?: string | number | null;
    paymentOption?: string | null;
    deliveryNote?: string | null;
    specialNotes?: string | null;
    confirmationDate?: string | null;
    terms?: string | null;
    specialInstructions?: string | null;
    extraLines?: string[];
};

function money(v: string | number | null | undefined): string {
    if (v == null || v === "") return "";
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(n)) return String(v);
    return `$${n.toFixed(2)}`;
}

function txt(v: string | number | null | undefined): string {
    if (v == null) return "";
    const s = String(v).trim();
    return s;
}

function line(doc: PDFKit.PDFDocument, label: string, value: string | null | undefined) {
    doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
    doc.font("Helvetica").text(value && String(value).trim() ? String(value) : "—");
}

function drawBox(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    w: number,
    h: number
) {
    doc.rect(x, y, w, h).stroke("#222222");
}

function fieldRow(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    x: number,
    y: number,
    w: number
) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#111111").text(label, x, y, { width: w });
    doc.font("Helvetica").fontSize(10).text(value || "—", x, y + 11, { width: w });
}

/**
 * Green Logistics Rate Confirmation layout (matches current RC form).
 */
function renderRateConfirmationPdf(
    doc: PDFKit.PDFDocument,
    content: LoadDocumentContent,
    version: number
) {
    const c = content;
    const left = 40;
    const pageW = 612;
    const usable = pageW - left * 2;
    let y = 36;

    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f3d1f").text(GREEN_LOGISTICS_RC.legalName, left, y);
    y += 16;
    doc.font("Helvetica").fontSize(9).fillColor("#222222");
    doc.text(GREEN_LOGISTICS_RC.addressLine1, left, y);
    y += 11;
    doc.text(GREEN_LOGISTICS_RC.addressLine2, left, y);
    y += 11;
    doc.text(`MC # ${GREEN_LOGISTICS_RC.mc}`, left, y);

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f3d1f");
    doc.text(`LOAD NO: ${txt(c.loadNumber) || "—"}`, left + usable - 180, 36, {
        width: 180,
        align: "right",
    });
    doc.font("Helvetica").fontSize(9).fillColor("#222222");
    doc.text(txt(c.confirmationDate) || new Date().toLocaleDateString(), left + usable - 180, 50, {
        width: 180,
        align: "right",
    });
    if (c.shipmentNumber) {
        doc.text(`Shipment: ${txt(c.shipmentNumber)}`, left + usable - 180, 62, {
            width: 180,
            align: "right",
        });
    }
    doc.text(`v${version}`, left + usable - 180, 74, { width: 180, align: "right" });

    y = 88;
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111");
    doc.text("LOAD CONFIRMATION AND PAYMENT AGREEMENT — PLEASE SIGN & RETURN ASAP", left, y, {
        width: usable,
        align: "center",
    });
    y += 22;

    // Email contacts — Broker Gmail / Customer / Carrier
    drawBox(doc, left, y, usable, 42);
    fieldRow(doc, "BROKER GMAIL:", txt(c.brokerEmail), left + 8, y + 6, 170);
    fieldRow(doc, "CUSTOMER EMAIL:", txt(c.customerEmail), left + 190, y + 6, 170);
    fieldRow(doc, "CARRIER EMAIL:", txt(c.carrierEmail), left + 370, y + 6, 160);
    if (c.customerName) {
        doc.font("Helvetica").fontSize(7).fillColor("#555555").text(
            `Customer: ${txt(c.customerName)}`,
            left + 190,
            y + 30,
            { width: 170 }
        );
    }
    y += 52;

    // Carrier / equipment / rate block
    drawBox(doc, left, y, usable, 90);
    fieldRow(doc, "CARRIER:", txt(c.carrierName), left + 8, y + 6, 220);
    fieldRow(doc, "MC#", txt(c.carrierMc), left + 240, y + 6, 90);
    fieldRow(doc, "DOT#", txt(c.carrierDot), left + 340, y + 6, 90);
    fieldRow(doc, "PHONE:", txt(c.carrierPhone), left + 440, y + 6, 90);
    fieldRow(doc, "CARRIER EMAIL:", txt(c.carrierEmail), left + 8, y + 40, 220);

    fieldRow(doc, "EQUIPMENT:", txt(c.equipment), left + 240, y + 40, 120);
    fieldRow(doc, "Weight:", txt(c.weight), left + 370, y + 40, 70);
    fieldRow(doc, "COMMODITY:", txt(c.commodity), left + 8, y + 64, 220);
    const rateVal = money(c.flatRate ?? c.carrierRate);
    fieldRow(doc, "Flat Rate: $USD", rateVal || "—", left + 240, y + 64, 120);
    y += 102;

    // Origin
    drawBox(doc, left, y, usable / 2 - 4, 92);
    doc.font("Helvetica-Bold").fontSize(9).text("ORIGIN:", left + 8, y + 6);
    doc.font("Helvetica").fontSize(10).text(txt(c.pickupAddress) || "—", left + 8, y + 20, {
        width: usable / 2 - 20,
    });
    fieldRow(doc, "DATE:", txt(c.pickupDate) || txt(c.pickupWindow), left + 8, y + 52, 100);
    fieldRow(doc, "TIME:", txt(c.pickupTime), left + 120, y + 52, 80);
    fieldRow(doc, "CONTACT:", txt(c.pickupContact), left + 8, y + 72, usable / 2 - 24);

    // Destination
    const dx = left + usable / 2 + 4;
    drawBox(doc, dx, y, usable / 2 - 4, 92);
    doc.font("Helvetica-Bold").fontSize(9).text("Final Destination", dx + 8, y + 6);
    doc.font("Helvetica").fontSize(10).text(txt(c.deliveryAddress) || "—", dx + 8, y + 20, {
        width: usable / 2 - 20,
    });
    fieldRow(doc, "DATE:", txt(c.deliveryDate) || txt(c.deliveryWindow), dx + 8, y + 52, 100);
    fieldRow(doc, "TIME:", txt(c.deliveryTime), dx + 120, y + 52, 80);
    fieldRow(doc, "CONTACT:", txt(c.deliveryContact), dx + 8, y + 72, usable / 2 - 24);
    y += 104;

    // Driver / payment / notes
    drawBox(doc, left, y, usable, 70);
    fieldRow(
        doc,
        "DRIVER INFORMATION:",
        [txt(c.driverName), txt(c.driverPhone), txt(c.truckNumber) ? `Truck ${txt(c.truckNumber)}` : "", txt(c.trailerNumber) ? `Trailer ${txt(c.trailerNumber)}` : ""]
            .filter(Boolean)
            .join(" · ") || "—",
        left + 8,
        y + 6,
        usable - 16
    );
    fieldRow(doc, "PAYMENT OPTION:", txt(c.paymentOption) || "—", left + 8, y + 36, usable / 2 - 16);
    fieldRow(doc, "DELIVERY NOTE:", txt(c.deliveryNote) || "—", left + usable / 2, y + 36, usable / 2 - 16);
    y += 82;

    drawBox(doc, left, y, usable, 48);
    doc.font("Helvetica-Bold").fontSize(8).text("SPECIAL NOTES:", left + 8, y + 6);
    doc.font("Helvetica").fontSize(9).text(
        txt(c.specialNotes) || txt(c.specialInstructions) || "—",
        left + 8,
        y + 18,
        { width: usable - 16, height: 26 }
    );
    y += 58;

    // Terms / notes from current RC
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#111111").text("Note: Please take a note:", left, y);
    y += 12;
    doc.font("Helvetica").fontSize(7.5).fillColor("#222222");
    const terms = txt(c.terms) || DEFAULT_RATE_CON_TERMS;
    doc.text(terms, left, y, { width: usable, align: "left" });
    y = doc.y + 10;

    doc.font("Helvetica-Bold").fontSize(8).text("Please have driver call for dispatch.", left, y);
    y += 11;
    doc.font("Helvetica").fontSize(8).text(`Phone: ${GREEN_LOGISTICS_RC.dispatchPhone}`, left, y);
    y += 11;
    doc.text("Confirmation must be signed and returned before driver can be dispatched.", left, y);
    y += 14;
    doc.font("Helvetica-Bold").fontSize(8).text("For billing use", left, y);
    y += 11;
    doc.font("Helvetica").fontSize(8).text(`Email: ${GREEN_LOGISTICS_RC.billingEmails.join("  ·  ")}`, left, y);
    y += 18;

    // Signatures
    if (y > 680) {
        doc.addPage();
        y = 50;
    }
    drawBox(doc, left, y, usable / 2 - 4, 70);
    doc.font("Helvetica-Bold").fontSize(8).text("CARRIER SIGNATURE:", left + 8, y + 8);
    doc.moveTo(left + 8, y + 48).lineTo(left + usable / 2 - 16, y + 48).stroke("#666666");
    doc.font("Helvetica").fontSize(7).text("DATE:", left + 8, y + 54);

    drawBox(doc, left + usable / 2 + 4, y, usable / 2 - 4, 70);
    doc.font("Helvetica-Bold").fontSize(8).text("BROKER SIGNATURE:", left + usable / 2 + 12, y + 8);
    doc.font("Helvetica").fontSize(9).text(GREEN_LOGISTICS_RC.legalName, left + usable / 2 + 12, y + 24);
    if (c.brokerName) {
        doc.text(txt(c.brokerName), left + usable / 2 + 12, y + 36);
    }
    doc.moveTo(left + usable / 2 + 12, y + 48)
        .lineTo(left + usable - 8, y + 48)
        .stroke("#666666");
    doc.font("Helvetica").fontSize(7).text("DATE:", left + usable / 2 + 12, y + 54);

    doc.font("Helvetica").fontSize(7).fillColor("#666666");
    doc.text(`${GREEN_LOGISTICS_RC.legalName}  ·  Page 1 of 1  ·  Generated by GreenOS`, left, 760, {
        width: usable,
        align: "center",
    });
}

/** Bill of Lading — includes Broker Gmail / Customer / Carrier emails. */
function renderBolPdf(doc: PDFKit.PDFDocument, content: LoadDocumentContent, version: number) {
    const c = content;
    const left = 40;
    const usable = 532;
    let y = 36;

    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f3d1f").text(GREEN_LOGISTICS_RC.legalName, left, y);
    y += 16;
    doc.font("Helvetica").fontSize(9).fillColor("#222222");
    doc.text(`${GREEN_LOGISTICS_RC.addressLine1}, ${GREEN_LOGISTICS_RC.addressLine2}`, left, y);
    y += 12;
    doc.text(`MC # ${GREEN_LOGISTICS_RC.mc}`, left, y);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f3d1f");
    doc.text(`LOAD NO: ${txt(c.loadNumber) || "—"}`, left + usable - 180, 36, {
        width: 180,
        align: "right",
    });
    doc.font("Helvetica").fontSize(9).fillColor("#222222");
    doc.text(txt(c.shipmentNumber) || "", left + usable - 180, 50, { width: 180, align: "right" });
    doc.text(`BOL v${version}`, left + usable - 180, 62, { width: 180, align: "right" });

    y = 78;
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#111111").text("BILL OF LADING", left, y, {
        width: usable,
        align: "center",
    });
    y += 22;

    drawBox(doc, left, y, usable, 48);
    fieldRow(doc, "BROKER GMAIL:", txt(c.brokerEmail), left + 8, y + 6, 170);
    fieldRow(doc, "CUSTOMER EMAIL:", txt(c.customerEmail), left + 190, y + 6, 170);
    fieldRow(doc, "CARRIER EMAIL:", txt(c.carrierEmail), left + 370, y + 6, 150);
    fieldRow(doc, "CUSTOMER:", txt(c.customerName), left + 8, y + 30, 250);
    fieldRow(doc, "BROKER:", txt(c.brokerName), left + 270, y + 30, 240);
    y += 58;

    drawBox(doc, left, y, usable, 56);
    fieldRow(doc, "CARRIER:", txt(c.carrierName), left + 8, y + 6, 200);
    fieldRow(doc, "MC#", txt(c.carrierMc), left + 220, y + 6, 90);
    fieldRow(doc, "DOT#", txt(c.carrierDot), left + 320, y + 6, 90);
    fieldRow(doc, "PHONE:", txt(c.carrierPhone), left + 420, y + 6, 90);
    fieldRow(doc, "DRIVER:", txt(c.driverName), left + 8, y + 32, 160);
    fieldRow(doc, "TRUCK:", txt(c.truckNumber), left + 180, y + 32, 100);
    fieldRow(doc, "TRAILER:", txt(c.trailerNumber), left + 300, y + 32, 100);
    y += 68;

    drawBox(doc, left, y, usable / 2 - 4, 80);
    doc.font("Helvetica-Bold").fontSize(9).text("SHIPPER / ORIGIN", left + 8, y + 6);
    doc.font("Helvetica").fontSize(10).text(txt(c.pickupAddress) || "—", left + 8, y + 20, {
        width: usable / 2 - 20,
    });
    fieldRow(doc, "DATE/TIME:", [txt(c.pickupDate), txt(c.pickupTime)].filter(Boolean).join(" ") || txt(c.pickupWindow), left + 8, y + 52, usable / 2 - 24);

    const dx = left + usable / 2 + 4;
    drawBox(doc, dx, y, usable / 2 - 4, 80);
    doc.font("Helvetica-Bold").fontSize(9).text("CONSIGNEE / DESTINATION", dx + 8, y + 6);
    doc.font("Helvetica").fontSize(10).text(txt(c.deliveryAddress) || "—", dx + 8, y + 20, {
        width: usable / 2 - 20,
    });
    fieldRow(doc, "DATE/TIME:", [txt(c.deliveryDate), txt(c.deliveryTime)].filter(Boolean).join(" ") || txt(c.deliveryWindow), dx + 8, y + 52, usable / 2 - 24);
    y += 92;

    drawBox(doc, left, y, usable, 56);
    fieldRow(doc, "COMMODITY:", txt(c.commodity), left + 8, y + 6, 220);
    fieldRow(doc, "WEIGHT:", txt(c.weight), left + 240, y + 6, 100);
    fieldRow(doc, "PIECES:", c.pieces != null ? String(c.pieces) : "", left + 360, y + 6, 80);
    fieldRow(doc, "EQUIPMENT:", txt(c.equipment), left + 8, y + 32, 220);
    fieldRow(doc, "REF:", txt(c.referenceNumber), left + 240, y + 32, 250);
    y += 68;

    if (txt(c.specialInstructions) || txt(c.specialNotes)) {
        drawBox(doc, left, y, usable, 50);
        doc.font("Helvetica-Bold").fontSize(8).text("SPECIAL INSTRUCTIONS:", left + 8, y + 6);
        doc.font("Helvetica").fontSize(9).text(
            txt(c.specialNotes) || txt(c.specialInstructions),
            left + 8,
            y + 18,
            { width: usable - 16, height: 28 }
        );
        y += 62;
    }

    drawBox(doc, left, y, usable / 2 - 4, 70);
    doc.font("Helvetica-Bold").fontSize(8).text("SHIPPER SIGNATURE:", left + 8, y + 8);
    doc.moveTo(left + 8, y + 48).lineTo(left + usable / 2 - 16, y + 48).stroke("#666666");
    doc.font("Helvetica").fontSize(7).text("DATE:", left + 8, y + 54);

    drawBox(doc, left + usable / 2 + 4, y, usable / 2 - 4, 70);
    doc.font("Helvetica-Bold").fontSize(8).text("CARRIER / DRIVER SIGNATURE:", left + usable / 2 + 12, y + 8);
    doc.moveTo(left + usable / 2 + 12, y + 48).lineTo(left + usable - 8, y + 48).stroke("#666666");
    doc.font("Helvetica").fontSize(7).text("DATE:", left + usable / 2 + 12, y + 54);

    doc.font("Helvetica").fontSize(7).fillColor("#666666");
    doc.text(`${GREEN_LOGISTICS_RC.legalName}  ·  BOL belongs to Load ${txt(c.loadNumber) || ""}  ·  GreenOS`, left, 760, {
        width: usable,
        align: "center",
    });
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
        const doc = new PDFDocument({ margin: 40, size: "LETTER" });
        const stream = fs.createWriteStream(dest);
        doc.pipe(stream);

        if (input.docType === "RATE_CONFIRMATION") {
            renderRateConfirmationPdf(doc, c, input.version);
        } else if (input.docType === "BOL") {
            renderBolPdf(doc, c, input.version);
        } else {
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
            line(doc, "Customer Email", c.customerEmail);
            line(doc, "Broker", c.brokerName);
            line(doc, "Broker Gmail", c.brokerEmail);
            line(doc, "Carrier", c.carrierName);
            line(doc, "Carrier Email", c.carrierEmail);
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

            if (input.docType === "CARRIER_INVOICE") {
                line(doc, "Carrier Rate", money(c.carrierRate) || "—");
            }
            if (input.docType === "CUSTOMER_INVOICE" || input.docType === "LOAD_SUMMARY") {
                line(doc, "Customer Rate", money(c.customerRate) || "—");
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
        }

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

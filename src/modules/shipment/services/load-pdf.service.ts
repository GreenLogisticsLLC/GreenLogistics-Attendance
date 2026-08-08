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
    vinNumber?: string | null;
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
    /** Master BOL fields (matches Green Logistics BOL.pdf). */
    bolNumber?: string | null;
    shipperIdNo?: string | null;
    consigneeIdNo?: string | null;
    sealNo?: string | null;
    /** PREPAID | COLLECT | 3RD_PARTY */
    freightTerms?: string | null;
    thirdPartyBillTo?: string | null;
    customerOrderNo?: string | null;
    packageType?: string | null;
    handlingQty?: string | number | null;
    handlingType?: string | null;
    packageQty?: string | number | null;
    hazmat?: boolean | string | null;
    palletSlip?: boolean | string | null;
    codAmount?: string | number | null;
    remittanceCodTo?: string | null;
    fob?: string | null;
    trailerLoadedBy?: string | null;
    freightCountedBy?: string | null;
    deliveredInGoodOrder?: boolean | string | null;
    exceptionsNotes?: string | null;
    receiverName?: string | null;
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

function truthyMark(v: unknown) {
    if (v === true) return "X";
    const s = String(v || "")
        .trim()
        .toUpperCase();
    return s === "TRUE" || s === "YES" || s === "1" || s === "Y" || s === "X" ? "X" : "";
}

/**
 * Master Bill of Lading — layout aligned with Green Logistics BOL.pdf
 * (ORIGINAL NOT NEGOTIABLE / SHIPS FROM / SHIPS TO / Carrier / Order / Signatures).
 */
function renderBolPdf(doc: PDFKit.PDFDocument, content: LoadDocumentContent, version: number) {
    const c = content;
    const left = 28;
    const usable = 556;
    let y = 28;
    const bolNo = txt(c.bolNumber) || txt(c.loadNumber) || "—";
    const terms = String(c.freightTerms || "PREPAID")
        .toUpperCase()
        .replace(/\s+/g, "_");

    // Header
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111").text("Bill of Lading", left, y);
    doc.font("Helvetica").fontSize(7).text("ORIGINAL — NOT NEGOTIABLE", left + 90, y + 3);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f3d1f").text(GREEN_LOGISTICS_RC.legalName, left + 280, y, {
        width: 160,
        align: "right",
    });
    doc.font("Helvetica").fontSize(8).fillColor("#222222").text(`Phone: ${GREEN_LOGISTICS_RC.dispatchPhone}`, left + 280, y + 12, {
        width: 160,
        align: "right",
    });
    y += 28;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111111");
    doc.text(`BILL OF LADING: ${bolNo}`, left, y);
    doc.text(`PICKUP DATE: ${txt(c.pickupDate) || txt(c.confirmationDate) || new Date().toLocaleDateString()}`, left + 200, y);
    doc.font("Helvetica").fontSize(8).text(`Load ${txt(c.loadNumber) || ""}  ·  ${txt(c.shipmentNumber) || ""}  ·  v${version}`, left + 400, y, {
        width: usable - 400,
        align: "right",
    });
    y += 16;

    // Email strip (GreenOS extension kept on company BOL)
    drawBox(doc, left, y, usable, 28);
    doc.font("Helvetica-Bold").fontSize(7).text("BROKER GMAIL", left + 4, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.brokerEmail) || "—", left + 4, y + 13, { width: 175 });
    doc.font("Helvetica-Bold").fontSize(7).text("CUSTOMER EMAIL", left + 190, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.customerEmail) || "—", left + 190, y + 13, { width: 175 });
    doc.font("Helvetica-Bold").fontSize(7).text("CARRIER EMAIL", left + 380, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.carrierEmail) || "—", left + 380, y + 13, { width: 170 });
    y += 34;

    // SHIPS FROM | Freight terms
    const rowH = 78;
    drawBox(doc, left, y, 300, rowH);
    doc.font("Helvetica-Bold").fontSize(8).text("SHIPS FROM", left + 4, y + 3);
    doc.font("Helvetica").fontSize(9).text(txt(c.pickupAddress) || "—", left + 4, y + 14, { width: 200, height: 36 });
    doc.font("Helvetica-Bold").fontSize(7).text("SHIPPER ID NO.", left + 4, y + 52);
    doc.font("Helvetica").fontSize(8).text(txt(c.shipperIdNo) || "—", left + 4, y + 62);
    doc.font("Helvetica-Bold").fontSize(7).text("SEAL NO.", left + 150, y + 52);
    doc.font("Helvetica").fontSize(8).text(txt(c.sealNo) || "—", left + 150, y + 62);
    doc.font("Helvetica-Bold").fontSize(7).text("FOB", left + 250, y + 52);
    doc.font("Helvetica").fontSize(8).text(txt(c.fob) || "", left + 250, y + 62);

    drawBox(doc, left + 300, y, usable - 300, rowH);
    doc.font("Helvetica-Bold").fontSize(8).text("FREIGHT CHARGE TERMS", left + 306, y + 3);
    const prepaid = terms.includes("PREPAID") ? "X" : "";
    const collect = terms.includes("COLLECT") && !terms.includes("3RD") ? "X" : "";
    const third = terms.includes("3RD") || terms.includes("THIRD") ? "X" : "";
    doc.font("Helvetica").fontSize(9);
    doc.text(`[${prepaid || " "}] PREPAID`, left + 310, y + 20);
    doc.text(`[${collect || " "}] COLLECT`, left + 310, y + 36);
    doc.text(`[${third || " "}] 3RD PARTY`, left + 310, y + 52);
    doc.font("Helvetica").fontSize(7).text("MASTER BILL OF LADING", left + 420, y + 20, { width: 150 });
    doc.text("(UNDERLYING BOL ATTACHED)", left + 420, y + 32, { width: 150 });
    y += rowH;

    // SHIPS TO | Carrier
    drawBox(doc, left, y, 300, 88);
    doc.font("Helvetica-Bold").fontSize(8).text("SHIPS TO", left + 4, y + 3);
    doc.font("Helvetica").fontSize(9).text(txt(c.deliveryAddress) || "—", left + 4, y + 14, { width: 200, height: 36 });
    doc.font("Helvetica-Bold").fontSize(7).text("CONSIGNEE ID NO.", left + 4, y + 52);
    doc.font("Helvetica").fontSize(8).text(txt(c.consigneeIdNo) || "—", left + 4, y + 62);
    doc.font("Helvetica-Bold").fontSize(7).text("CONTACT", left + 150, y + 52);
    doc.font("Helvetica").fontSize(8).text(txt(c.deliveryContact) || txt(c.pickupContact) || "—", left + 150, y + 62);

    drawBox(doc, left + 300, y, usable - 300, 88);
    doc.font("Helvetica-Bold").fontSize(8).text("CARRIER", left + 306, y + 3);
    doc.font("Helvetica").fontSize(9).text(txt(c.carrierName) || "—", left + 306, y + 14, { width: 240 });
    doc.font("Helvetica").fontSize(8);
    doc.text(`MC: ${txt(c.carrierMc) || "—"}`, left + 306, y + 36);
    doc.text(`Truck: ${txt(c.truckNumber) || "—"}`, left + 400, y + 36);
    doc.text(`Trailer#: ${txt(c.trailerNumber) || "—"}`, left + 306, y + 50);
    doc.text(`VIN#: ${txt(c.vinNumber) || "—"}`, left + 400, y + 50);
    doc.text(`CONTACT: ${txt(c.carrierPhone) || txt(c.driverPhone) || txt(c.driverName) || "—"}`, left + 306, y + 64, {
        width: 240,
    });
    y += 88;

    // Third party
    drawBox(doc, left, y, usable, 32);
    doc.font("Helvetica-Bold").fontSize(7).text("THIRD PARTY FREIGHT BILLS TO", left + 4, y + 3);
    doc.font("Helvetica").fontSize(9).text(txt(c.thirdPartyBillTo) || txt(c.customerName) || "—", left + 4, y + 14, {
        width: usable - 8,
    });
    y += 36;

    // Customer order info
    drawBox(doc, left, y, usable, 52);
    doc.font("Helvetica-Bold").fontSize(8).text("CUSTOMER ORDER INFORMATION", left + 4, y + 3);
    doc.font("Helvetica-Bold").fontSize(6.5);
    doc.text("CUSTOMER ORDER NO.", left + 4, y + 16);
    doc.text("# PKGS", left + 160, y + 16);
    doc.text("WEIGHT", left + 220, y + 16);
    doc.text("PALLET/SLIP", left + 290, y + 16);
    doc.text("ADDL. SHIPPER INFORMATION", left + 380, y + 16);
    doc.font("Helvetica").fontSize(9);
    doc.text(txt(c.customerOrderNo) || txt(c.referenceNumber) || "—", left + 4, y + 28, { width: 150 });
    doc.text(String(c.pieces ?? c.packageQty ?? "—"), left + 160, y + 28);
    doc.text(txt(c.weight) || "—", left + 220, y + 28);
    const pal = truthyMark(c.palletSlip);
    doc.text(`Y [${pal === "X" ? "X" : " "}]   N [${pal === "X" ? " " : "X"}]`, left + 290, y + 28);
    doc.text(txt(c.specialNotes) || "", left + 380, y + 28, { width: 168, height: 18 });
    y += 56;

    // Carrier information / commodity grid
    drawBox(doc, left, y, usable, 78);
    doc.font("Helvetica-Bold").fontSize(8).text("CARRIER INFORMATION", left + 4, y + 3);
    doc.font("Helvetica-Bold").fontSize(6.5);
    doc.text("HANDLING UNIT", left + 4, y + 16);
    doc.text("QTY", left + 4, y + 26);
    doc.text("TYPE", left + 40, y + 26);
    doc.text("PACKAGE", left + 100, y + 16);
    doc.text("QTY", left + 100, y + 26);
    doc.text("TYPE", left + 140, y + 26);
    doc.text("WEIGHT", left + 200, y + 16);
    doc.text("H.M.(X)", left + 260, y + 16);
    doc.text("COMMODITY DESCRIPTION", left + 310, y + 16);
    doc.font("Helvetica").fontSize(9);
    doc.text(String(c.handlingQty ?? c.pieces ?? ""), left + 4, y + 40);
    doc.text(txt(c.handlingType) || "PLT", left + 40, y + 40);
    doc.text(String(c.packageQty ?? c.pieces ?? ""), left + 100, y + 40);
    doc.text(txt(c.packageType) || "PCS", left + 140, y + 40);
    doc.text(txt(c.weight) || "", left + 200, y + 40);
    doc.text(truthyMark(c.hazmat) || "", left + 270, y + 40);
    doc.text(txt(c.commodity) || "—", left + 310, y + 40, { width: 240, height: 28 });
    doc.font("Helvetica-Bold").fontSize(7).text("GRAND TOTAL", left + 4, y + 62);
    doc.font("Helvetica").fontSize(8).text(
        `TOTAL # PKGS: ${String(c.pieces ?? c.packageQty ?? "—")}    TOTAL WEIGHT: ${txt(c.weight) || "—"}`,
        left + 80,
        y + 62
    );
    y += 84;

    // Special instructions + COD
    drawBox(doc, left, y, usable * 0.65, 48);
    doc.font("Helvetica-Bold").fontSize(7).text("ADDITIONAL SERVICES / SPECIAL INSTRUCTIONS", left + 4, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.specialInstructions) || txt(c.specialNotes) || "—", left + 4, y + 14, {
        width: usable * 0.65 - 8,
        height: 30,
    });
    drawBox(doc, left + usable * 0.65, y, usable * 0.35, 48);
    doc.font("Helvetica-Bold").fontSize(7).text("COD AMOUNT $", left + usable * 0.65 + 4, y + 3);
    doc.font("Helvetica").fontSize(10).text(money(c.codAmount) || txt(c.codAmount as string) || "", left + usable * 0.65 + 4, y + 16);
    doc.font("Helvetica-Bold").fontSize(7).text("REMIT COD TO", left + usable * 0.65 + 4, y + 30);
    doc.font("Helvetica").fontSize(7).text(txt(c.remittanceCodTo) || "", left + usable * 0.65 + 4, y + 38, {
        width: usable * 0.35 - 8,
    });
    y += 54;

    // Legal / certifications
    doc.font("Helvetica").fontSize(6.5).fillColor("#222222");
    doc.text(
        "This is to certify that the above named materials are properly classified, described, packaged, marked and labeled, and are in proper condition for transportation according to the applicable regulations of the U.S. DOT.",
        left,
        y,
        { width: usable / 2 - 6 }
    );
    doc.text(
        "Carrier acknowledges receipt of packages and required placards. Carrier certifies emergency response information was made available and/or carrier has the U.S. DOT emergency response guidebook or equivalent documentation in the vehicle. Property described above is received in good order, except as noted.",
        left + usable / 2,
        y,
        { width: usable / 2 - 2 }
    );
    y += 42;

    // Trailer loaded / freight counted
    drawBox(doc, left, y, usable, 36);
    doc.font("Helvetica-Bold").fontSize(7).text("TRAILER LOADED", left + 4, y + 3);
    doc.font("Helvetica").fontSize(8);
    const loaded = String(c.trailerLoadedBy || "").toUpperCase();
    doc.text(`[${loaded.includes("SHIPPER") ? "X" : " "}] BY SHIPPER    [${loaded.includes("DRIVER") ? "X" : " "}] BY DRIVER`, left + 4, y + 16);
    doc.font("Helvetica-Bold").fontSize(7).text("FREIGHT COUNTED", left + 280, y + 3);
    doc.font("Helvetica").fontSize(8);
    const counted = String(c.freightCountedBy || "").toUpperCase();
    doc.text(
        `[${counted.includes("SHIPPER") ? "X" : " "}] BY SHIPPER  [${counted.includes("DRIVER") && counted.includes("PALLET") ? "X" : " "}] BY DRIVER/PALLETS  [${counted.includes("PIECE") ? "X" : " "}] BY DRIVER/PIECES`,
        left + 280,
        y + 16,
        { width: 270 }
    );
    y += 42;

    // Signatures
    const sigH = 70;
    drawBox(doc, left, y, usable / 3 - 2, sigH);
    doc.font("Helvetica-Bold").fontSize(7).text("SHIPPER SIGNATURE / DATE", left + 4, y + 4);
    doc.moveTo(left + 8, y + 40).lineTo(left + usable / 3 - 12, y + 40).stroke("#666");
    doc.font("Helvetica").fontSize(7).text("DATE ______________", left + 8, y + 52);

    drawBox(doc, left + usable / 3, y, usable / 3 - 2, sigH);
    doc.font("Helvetica-Bold").fontSize(7).text("CARRIER SIGNATURE / PICKUP DATE", left + usable / 3 + 4, y + 4);
    doc.font("Helvetica").fontSize(8).text(txt(c.carrierName) || "", left + usable / 3 + 4, y + 16, { width: usable / 3 - 12 });
    doc.moveTo(left + usable / 3 + 8, y + 40).lineTo(left + (usable * 2) / 3 - 12, y + 40).stroke("#666");
    doc.font("Helvetica").fontSize(7).text("DATE ______________", left + usable / 3 + 8, y + 52);

    drawBox(doc, left + (usable * 2) / 3, y, usable / 3, sigH);
    doc.font("Helvetica-Bold").fontSize(7).text("RECEIVER (CONSIGNEE) SIGNATURE", left + (usable * 2) / 3 + 4, y + 4);
    doc.font("Helvetica").fontSize(6).text(
        "IMPORTANT: Property received in apparent good order, count and condition verified except as noted.",
        left + (usable * 2) / 3 + 4,
        y + 14,
        { width: usable / 3 - 8 }
    );
    doc.moveTo(left + (usable * 2) / 3 + 8, y + 42).lineTo(left + usable - 8, y + 42).stroke("#666");
    doc.font("Helvetica").fontSize(6).text("PRINT NAME / SIGNATURE / DATE", left + (usable * 2) / 3 + 8, y + 52);
    y += sigH + 8;

    drawBox(doc, left, y, usable, 36);
    doc.font("Helvetica-Bold").fontSize(7).text("RECEIVING STAMP SPACE", left + 4, y + 4);
    doc.font("Helvetica").fontSize(8).fillColor("#888888").text("(stamp here)", left + 4, y + 16);

    doc.font("Helvetica").fontSize(6.5).fillColor("#666666");
    doc.text(
        `${GREEN_LOGISTICS_RC.legalName}  ·  MC# ${GREEN_LOGISTICS_RC.mc}  ·  ${GREEN_LOGISTICS_RC.addressLine1}, ${GREEN_LOGISTICS_RC.addressLine2}  ·  GreenOS Load Document`,
        left,
        772,
        { width: usable, align: "center" }
    );
}

/**
 * Proof of Delivery — same Green Logistics header/contacts as BOL, delivery-focused.
 */
function renderPodPdf(doc: PDFKit.PDFDocument, content: LoadDocumentContent, version: number) {
    const c = content;
    const left = 28;
    const usable = 556;
    let y = 28;
    const bolNo = txt(c.bolNumber) || txt(c.loadNumber) || "—";

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111").text("Proof of Delivery (POD)", left, y);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f3d1f").text(GREEN_LOGISTICS_RC.legalName, left + 280, y, {
        width: 160,
        align: "right",
    });
    doc.font("Helvetica").fontSize(8).fillColor("#222222").text(`Phone: ${GREEN_LOGISTICS_RC.dispatchPhone}`, left + 280, y + 12, {
        width: 160,
        align: "right",
    });
    y += 28;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111111");
    doc.text(`BILL OF LADING / LOAD: ${bolNo}`, left, y);
    doc.text(`DELIVERY DATE: ${txt(c.deliveryDate) || "______________"}`, left + 260, y);
    doc.font("Helvetica").fontSize(8).text(`v${version}`, left + 500, y);
    y += 16;

    drawBox(doc, left, y, usable, 28);
    doc.font("Helvetica-Bold").fontSize(7).text("BROKER GMAIL", left + 4, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.brokerEmail) || "—", left + 4, y + 13, { width: 175 });
    doc.font("Helvetica-Bold").fontSize(7).text("CUSTOMER EMAIL", left + 190, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.customerEmail) || "—", left + 190, y + 13, { width: 175 });
    doc.font("Helvetica-Bold").fontSize(7).text("CARRIER EMAIL", left + 380, y + 3);
    doc.font("Helvetica").fontSize(8).text(txt(c.carrierEmail) || "—", left + 380, y + 13, { width: 170 });
    y += 34;

    drawBox(doc, left, y, usable / 2 - 2, 90);
    doc.font("Helvetica-Bold").fontSize(8).text("SHIPPED FROM", left + 4, y + 4);
    doc.font("Helvetica").fontSize(9).text(txt(c.pickupAddress) || "—", left + 4, y + 18, { width: usable / 2 - 12, height: 40 });
    doc.font("Helvetica").fontSize(8).text(`Pickup: ${txt(c.pickupDate) || "—"} ${txt(c.pickupTime) || ""}`, left + 4, y + 64);

    drawBox(doc, left + usable / 2, y, usable / 2, 90);
    doc.font("Helvetica-Bold").fontSize(8).text("DELIVERED TO", left + usable / 2 + 4, y + 4);
    doc.font("Helvetica").fontSize(9).text(txt(c.deliveryAddress) || "—", left + usable / 2 + 4, y + 18, {
        width: usable / 2 - 12,
        height: 40,
    });
    doc.font("Helvetica").fontSize(8).text(
        `Delivery: ${txt(c.deliveryDate) || "—"} ${txt(c.deliveryTime) || ""}`,
        left + usable / 2 + 4,
        y + 64
    );
    y += 96;

    drawBox(doc, left, y, usable, 70);
    doc.font("Helvetica-Bold").fontSize(8).text("CARRIER", left + 4, y + 4);
    doc.font("Helvetica").fontSize(9).text(txt(c.carrierName) || "—", left + 4, y + 16);
    doc.text(`MC: ${txt(c.carrierMc) || "—"}   Truck: ${txt(c.truckNumber) || "—"}   Trailer#: ${txt(c.trailerNumber) || "—"}`, left + 4, y + 32);
    doc.text(`Driver: ${txt(c.driverName) || "—"}   Phone: ${txt(c.driverPhone) || txt(c.carrierPhone) || "—"}`, left + 4, y + 48);
    y += 78;

    drawBox(doc, left, y, usable, 70);
    doc.font("Helvetica-Bold").fontSize(8).text("COMMODITY / PIECES / WEIGHT", left + 4, y + 4);
    doc.font("Helvetica").fontSize(9);
    doc.text(`Commodity: ${txt(c.commodity) || "—"}`, left + 4, y + 18, { width: usable - 8 });
    doc.text(`# Pkgs: ${String(c.pieces ?? "—")}    Weight: ${txt(c.weight) || "—"}    Ref: ${txt(c.referenceNumber) || "—"}`, left + 4, y + 36);
    doc.text(`Customer: ${txt(c.customerName) || "—"}`, left + 4, y + 52);
    y += 78;

    drawBox(doc, left, y, usable, 56);
    doc.font("Helvetica-Bold").fontSize(8).text("DELIVERY CONDITION / EXCEPTIONS", left + 4, y + 4);
    const good = c.deliveredInGoodOrder == null || truthyMark(c.deliveredInGoodOrder) === "X";
    doc.font("Helvetica").fontSize(9);
    doc.text(`[${good ? "X" : " "}] Received in apparent good order, count and condition`, left + 4, y + 18);
    doc.text(`[${!good ? "X" : " "}] Exceptions noted below`, left + 4, y + 32);
    doc.text(txt(c.exceptionsNotes) || txt(c.deliveryNote) || "", left + 250, y + 18, { width: 290, height: 32 });
    y += 64;

    drawBox(doc, left, y, usable, 48);
    doc.font("Helvetica-Bold").fontSize(8).text("SPECIAL NOTES / INSTRUCTIONS", left + 4, y + 4);
    doc.font("Helvetica").fontSize(8).text(txt(c.specialInstructions) || txt(c.specialNotes) || "—", left + 4, y + 16, {
        width: usable - 8,
        height: 28,
    });
    y += 56;

    drawBox(doc, left, y, usable / 2 - 2, 90);
    doc.font("Helvetica-Bold").fontSize(8).text("RECEIVER (CONSIGNEE) SIGNATURE", left + 4, y + 4);
    doc.font("Helvetica").fontSize(8).text(`Print name: ${txt(c.receiverName) || "________________"}`, left + 4, y + 22);
    doc.moveTo(left + 8, y + 55).lineTo(left + usable / 2 - 16, y + 55).stroke("#666");
    doc.font("Helvetica").fontSize(7).text("SIGNATURE", left + 8, y + 60);
    doc.text("DATE ______________", left + 160, y + 60);

    drawBox(doc, left + usable / 2, y, usable / 2, 90);
    doc.font("Helvetica-Bold").fontSize(8).text("DRIVER / CARRIER SIGNATURE", left + usable / 2 + 4, y + 4);
    doc.font("Helvetica").fontSize(8).text(txt(c.driverName) || txt(c.carrierName) || "", left + usable / 2 + 4, y + 22);
    doc.moveTo(left + usable / 2 + 8, y + 55).lineTo(left + usable - 8, y + 55).stroke("#666");
    doc.font("Helvetica").fontSize(7).text("SIGNATURE", left + usable / 2 + 8, y + 60);
    doc.text("DATE ______________", left + usable / 2 + 160, y + 60);
    y += 100;

    drawBox(doc, left, y, usable, 50);
    doc.font("Helvetica-Bold").fontSize(7).text("RECEIVING STAMP SPACE", left + 4, y + 4);
    doc.font("Helvetica").fontSize(8).fillColor("#888888").text("(stamp / photo POD reference)", left + 4, y + 18);

    doc.font("Helvetica").fontSize(6.5).fillColor("#666666");
    doc.text(
        `${GREEN_LOGISTICS_RC.legalName}  ·  Clear POD photo required within 24 hours  ·  GreenOS Load Document`,
        left,
        772,
        { width: usable, align: "center" }
    );
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
        const doc = new PDFDocument({ margin: 28, size: "LETTER" });
        const stream = fs.createWriteStream(dest);
        doc.pipe(stream);

        if (input.docType === "RATE_CONFIRMATION") {
            renderRateConfirmationPdf(doc, c, input.version);
        } else if (input.docType === "BOL") {
            renderBolPdf(doc, c, input.version);
        } else if (input.docType === "POD") {
            renderPodPdf(doc, c, input.version);
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

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import type { CustomerAgreementType } from "./customer-agreement.js";
import {
    customerAgreementFields,
    customerAgreementSections,
    customerAgreementSubtitle,
    customerAgreementTitle,
} from "./customer-agreement-fields.js";

export type CustomerAgreementPdfInput = {
    agreementType: CustomerAgreementType;
    companyName: string;
    brokerName: string;
    brokerTitle?: string;
    sentAt: Date;
    fields?: Record<string, string>;
    customerSignatureDataUrl?: string | null;
    customerSignerName?: string | null;
    signedAt?: Date | null;
    timezone?: string;
};

function fmtDate(d: Date, timezone = "America/Los_Angeles"): string {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "long",
            day: "numeric",
        }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

function signatureBuffer(dataUrl?: string | null): Buffer | null {
    const m = String(dataUrl || "").match(/^data:image\/\w+;base64,(.+)$/);
    if (!m) return null;
    try {
        return Buffer.from(m[1], "base64");
    } catch {
        return null;
    }
}

function resolveCompanySignaturePng(): string | null {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.resolve(here, "../carriers/assets/spartak-kazaryan-signature.png"),
        path.join(process.cwd(), "src/modules/carriers/assets/spartak-kazaryan-signature.png"),
        path.join(process.cwd(), "dist/modules/carriers/assets/spartak-kazaryan-signature.png"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function drawFieldLine(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    y: number,
    left: number,
    width: number
): number {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text(label, left, y, { width });
    y = doc.y + 2;
    const lineY = y + 12;
    doc.moveTo(left, lineY).lineTo(left + width, lineY).strokeColor("#94a3b8").lineWidth(0.7).stroke();
    if (value) {
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(value, left, y, {
            width: width - 4,
            lineBreak: false,
        });
    }
    return lineY + 10;
}

export async function buildCustomerAgreementPdf(
    input: CustomerAgreementPdfInput
): Promise<Buffer> {
    const fields = input.fields || {};
    const brokerTitle = String(input.brokerTitle || "Broker").trim() || "Broker";
    const timezone = input.timezone || "America/Los_Angeles";
    const sendDate = fmtDate(input.sentAt, timezone);
    const signedDate = input.signedAt ? fmtDate(input.signedAt, timezone) : "";
    const fieldDefs = customerAgreementFields(input.agreementType);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "LETTER",
            margins: { top: 48, bottom: 48, left: 54, right: 54 },
            info: {
                Title: customerAgreementTitle(input.agreementType),
                Author: "Green Logistics LLC",
            },
        });
        const chunks: Buffer[] = [];
        doc.on("data", (c) => chunks.push(c as Buffer));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const left = doc.page.margins.left;
        const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

        doc.font("Helvetica-Bold").fontSize(14).fillColor("#0b3d2e").text("GREEN LOGISTICS LLC", {
            align: "center",
        });
        doc.moveDown(0.25);
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(customerAgreementTitle(input.agreementType), {
            align: "center",
        });
        doc.font("Helvetica").fontSize(10).fillColor("#334155").text(customerAgreementSubtitle(input.agreementType), {
            align: "center",
        });
        doc.moveDown(0.6);
        doc.font("Helvetica").fontSize(9).fillColor("#1e293b").text(
            `This Agreement is between Green Logistics LLC ("Broker") and ${input.companyName || "the Customer"} ("Customer"). FMCSA Broker Authority MC #1237784.`,
            { width, align: "left" }
        );
        doc.moveDown(0.35);
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a").text(`Document date (sent): ${sendDate}`);

        let currentSection = "";
        for (const field of fieldDefs) {
            if (field.section !== currentSection) {
                currentSection = field.section;
                doc.moveDown(0.55);
                if (doc.y > doc.page.height - 120) doc.addPage();
                doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b3d2e").text(currentSection.toUpperCase());
                doc.moveDown(0.2);
            }
            if (doc.y > doc.page.height - 90) doc.addPage();
            const y = doc.y;
            const next = drawFieldLine(doc, field.label, String(fields[field.key] || ""), y, left, width);
            doc.y = next;
        }

        doc.moveDown(0.5);
        if (doc.y > doc.page.height - 160) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b3d2e").text("AGREEMENT TERMS");
        doc.moveDown(0.15);
        doc.font("Helvetica").fontSize(8).fillColor("#64748b").text(
            "Full operative clauses from the Broker Customer agreement document selected for this shipment.",
            { width }
        );
        doc.moveDown(0.25);
        for (const section of customerAgreementSections(input.agreementType)) {
            if (doc.y > doc.page.height - 100) doc.addPage();
            doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#0b3d2e").text(section.title, {
                width,
            });
            doc.moveDown(0.12);
            for (const line of section.lines) {
                if (doc.y > doc.page.height - 70) doc.addPage();
                doc.font("Helvetica").fontSize(8).fillColor("#1e293b").text(line, {
                    width,
                    align: "left",
                });
                doc.moveDown(0.1);
            }
            doc.moveDown(0.2);
        }

        if (doc.y > doc.page.height - 220) doc.addPage();
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b3d2e").text("CUSTOMER");
        doc.moveDown(0.2);
        let y = doc.y;
        y = drawFieldLine(
            doc,
            "Full Name / Authorized Representative",
            String(
                fields.customerFullName ||
                    fields.customerRepSign ||
                    fields.fullLegalName ||
                    fields.authorizedRepresentative ||
                    input.customerSignerName ||
                    ""
            ),
            y,
            left,
            width
        );
        y = drawFieldLine(
            doc,
            "Company",
            String(fields.customerCompany || fields.customerCompanySign || fields.companyName || fields.legalCompanyName || ""),
            y,
            left,
            width
        );
        doc.y = y + 4;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text("Authorized Signature");
        const custSig = signatureBuffer(input.customerSignatureDataUrl);
        if (custSig) {
            try {
                doc.image(custSig, left, doc.y + 2, { height: 42, fit: [width * 0.55, 48] });
                doc.y += 50;
            } catch {
                doc.moveDown(2);
            }
        } else {
            doc.moveDown(0.2);
            doc.moveTo(left, doc.y + 28).lineTo(left + width * 0.55, doc.y + 28).strokeColor("#94a3b8").stroke();
            doc.y += 36;
        }
        y = drawFieldLine(doc, "Date", signedDate || "(signed online)", doc.y, left, width * 0.45);
        doc.y = Math.max(doc.y, y);

        doc.moveDown(0.7);
        if (doc.y > doc.page.height - 180) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b3d2e").text("BROKER");
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text("GREEN LOGISTICS LLC");
        doc.font("Helvetica").fontSize(8.5).fillColor("#475569").text("FMCSA Broker Authority: MC #1237784");
        doc.moveDown(0.25);
        y = drawFieldLine(doc, "Authorized Representative", input.brokerName, doc.y, left, width);
        y = drawFieldLine(doc, "Title", brokerTitle, y, left, width);
        doc.y = y + 4;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text("Signature");
        // Name first, then handwritten signature below — never overlap the employee name.
        const nameTop = doc.y + 4;
        doc.font("Times-Italic").fontSize(14).fillColor("#0f172a").text(input.brokerName, left, nameTop, {
            width: width * 0.55,
        });
        const companySig = resolveCompanySignaturePng();
        const sigTop = Math.max(doc.y, nameTop + 18) + 10;
        let sigBottom = sigTop + 28;
        if (companySig) {
            try {
                doc.image(companySig, left, sigTop, { height: 42, fit: [width * 0.5, 48] });
                sigBottom = sigTop + 48;
            } catch {
                /* keep spacing */
            }
        } else {
            doc.moveTo(left, sigTop + 22)
                .lineTo(left + width * 0.5, sigTop + 22)
                .strokeColor("#94a3b8")
                .lineWidth(0.7)
                .stroke();
            sigBottom = sigTop + 28;
        }
        doc.y = sigBottom + 8;
        drawFieldLine(doc, "Date", sendDate, doc.y, left, width * 0.45);

        doc.end();
    });
}

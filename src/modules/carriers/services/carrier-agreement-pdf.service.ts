import fs from "fs";
import path from "path";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import { carrierStorageService, CARRIER_UPLOADS_ROOT } from "./carrier-storage.service.js";

export type AgreementPdfInput = {
    carrierId: string;
    legalName: string;
    dbaName?: string | null;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    fax?: string | null;
    federalTaxId?: string | null;
    mcNumber?: string | null;
    dotNumber?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    equipmentNotes?: string | null;
    paymentOption?: string | null;
    agreementTitle: string;
    agreementVersion: string;
    agreementBody: string;
    signerName: string;
    signerEmail: string;
    signatureDataUrl: string;
    signedAt: Date;
    ipAddress?: string | null;
    documentHash?: string | null;
};

function paymentLabel(code: string | null | undefined): string {
    switch (String(code || "").toUpperCase()) {
        case "STANDARD":
            return "Standard Payment (20-25 days)";
        case "QUICK_3":
            return "Quick Pay 3% (3-5 business days, ACH)";
        case "QUICK_5":
            return "Quick Pay 5% (24hrs)";
        case "FACTORING":
            return "Factoring company (LOR required)";
        default:
            return code || "—";
    }
}

function signatureBuffer(dataUrl: string): Buffer | null {
    const m = String(dataUrl || "").match(/^data:image\/\w+;base64,(.+)$/);
    if (!m) return null;
    try {
        return Buffer.from(m[1], "base64");
    } catch {
        return null;
    }
}

/** Build Broker–Carrier Agreement PDF (full text + carrier profile + signature). */
export function buildCarrierAgreementPdf(input: AgreementPdfInput): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: "LETTER",
            margins: { top: 48, bottom: 48, left: 54, right: 54 },
            info: {
                Title: `${input.agreementTitle} — ${input.legalName}`,
                Author: "Green Logistics LLC",
                Subject: `Signed Broker-Carrier Agreement v${input.agreementVersion}`,
            },
        });
        const chunks: Buffer[] = [];
        doc.on("data", (c) => chunks.push(c as Buffer));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        doc.fillColor("#059669").fontSize(16).font("Helvetica-Bold").text("GREEN LOGISTICS LLC", {
            align: "center",
        });
        doc.moveDown(0.25);
        doc.fillColor("#152033").fontSize(10).font("Helvetica").text("121 Frog Hollow Rd, Churchville, PA 18966", {
            align: "center",
        });
        doc.text("Ph (267) 703-5313  ·  MC # 1237784", { align: "center" });
        doc.moveDown(0.8);
        doc.fontSize(13).font("Helvetica-Bold").text(input.agreementTitle, { align: "center" });
        doc.fontSize(9).font("Helvetica").fillColor("#5b6b84").text(`Version ${input.agreementVersion}`, {
            align: "center",
        });
        doc.moveDown(0.8);

        doc.fillColor("#152033").fontSize(11).font("Helvetica-Bold").text("Carrier Profile");
        doc.moveDown(0.3);
        doc.fontSize(9).font("Helvetica");
        const profile: Array<[string, string]> = [
            ["Carrier Name", input.legalName || "—"],
            ["DBA", input.dbaName || "—"],
            ["Dispatch Contact", input.contactName || "—"],
            ["Email", input.email || "—"],
            ["Phone", input.phone || "—"],
            ["Fax", input.fax || "—"],
            ["FED ID #", input.federalTaxId || "—"],
            ["MC #", input.mcNumber || "—"],
            ["DOT #", input.dotNumber || "—"],
            [
                "Address",
                [input.address, input.city, input.state, input.zip].filter(Boolean).join(", ") || "—",
            ],
            ["Equipment", input.equipmentNotes || "—"],
            ["Payment option", paymentLabel(input.paymentOption)],
        ];
        for (const [label, value] of profile) {
            doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
            doc.font("Helvetica").text(value);
        }

        doc.moveDown(0.8);
        doc.fontSize(11).font("Helvetica-Bold").text("Agreement");
        doc.moveDown(0.35);
        doc.fontSize(8.5).font("Helvetica").fillColor("#152033").text(input.agreementBody || "", {
            align: "left",
            lineGap: 1.5,
        });

        doc.addPage();
        doc.fillColor("#059669").fontSize(14).font("Helvetica-Bold").text("Signature & Acknowledgement", {
            align: "center",
        });
        doc.moveDown(0.8);
        doc.fillColor("#152033").fontSize(10).font("Helvetica");
        doc.text(
            "By signing below, Carrier confirms they have read and agree to the Broker–Carrier Agreement. This record creates an audit trail in Green OS."
        );
        doc.moveDown(0.8);

        doc.font("Helvetica-Bold").text("BROKER — GREEN LOGISTICS LLC");
        doc.font("Helvetica").text("Authorized Signature / Printed Name: SPARTAK KAZARYAN");
        doc.text("Title: PRESIDENT");
        doc.text("91 N York Rd Apt 500-40, Willow Grove, PA 19090");
        doc.text("Phone: (484) 929-1404  ·  Email: tbgreenlogistics@gmail.com");
        doc.moveDown(1);

        doc.font("Helvetica-Bold").text("CARRIER");
        doc.font("Helvetica").text(`Printed Name: ${input.signerName}`);
        doc.text(`Email: ${input.signerEmail}`);
        doc.text(`Signed at: ${input.signedAt.toISOString()}`);
        if (input.ipAddress) doc.text(`IP address: ${input.ipAddress}`);
        if (input.documentHash) doc.text(`Document hash: ${input.documentHash}`);
        doc.moveDown(0.6);
        doc.font("Helvetica-Bold").text("Electronic signature:");
        doc.moveDown(0.3);

        const img = signatureBuffer(input.signatureDataUrl);
        if (img) {
            try {
                const y = doc.y;
                doc.rect(doc.page.margins.left, y, 280, 90).stroke("#d5dde9");
                doc.image(img, doc.page.margins.left + 8, y + 8, {
                    fit: [264, 74],
                    valign: "center",
                });
                doc.y = y + 100;
            } catch {
                doc.font("Helvetica").fillColor("#5b6b84").text("(Signature image could not be embedded)");
            }
        } else {
            doc.font("Helvetica").fillColor("#5b6b84").text("(No signature image)");
        }

        doc.moveDown(1.2);
        doc.fillColor("#5b6b84").fontSize(8).font("Helvetica").text(
            "Generated by Green OS · Green Logistics LLC · This PDF is the system-of-record copy of the signed agreement.",
            { align: "center" }
        );

        doc.end();
    });
}

/** Write agreement PDF to carrier storage and return file meta. */
export async function storeCarrierAgreementPdf(
    input: AgreementPdfInput & { version: number }
): Promise<{ storageKey: string; checksum: string; fileSize: number; absolutePath: string }> {
    const buf = await buildCarrierAgreementPdf(input);
    const dir = carrierStorageService.ensureDir(input.carrierId);
    const storageKey = `BROKER_CARRIER_AGREEMENT_v${input.version}_${Date.now()}_signed.pdf`;
    const absolutePath = path.join(dir, storageKey);
    fs.writeFileSync(absolutePath, buf);
    const checksum = crypto.createHash("sha256").update(buf).digest("hex");
    return {
        storageKey,
        checksum,
        fileSize: buf.length,
        absolutePath,
    };
}

export { CARRIER_UPLOADS_ROOT };

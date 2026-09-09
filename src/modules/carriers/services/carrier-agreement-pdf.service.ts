import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { BROKER_AGREEMENT_CONTACT } from "../constants.js";
import { carrierStorageService, CARRIER_UPLOADS_ROOT } from "./carrier-storage.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_SIGNATURE_PNG = path.resolve(
    __dirname,
    "../assets/spartak-kazaryan-signature.png"
);

function resolveBrokerSignaturePng(): string | null {
    const candidates = [
        BROKER_SIGNATURE_PNG,
        path.join(process.cwd(), "src/modules/carriers/assets/spartak-kazaryan-signature.png"),
        path.join(process.cwd(), "dist/modules/carriers/assets/spartak-kazaryan-signature.png"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

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
            return "Factoring company";
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

/** Split template body so signature blocks can be drawn as real images. */
function splitAgreementBody(body: string): { before: string; after: string } {
    const raw = String(body || "");
    const markers = [
        /\nIN WITNESS WHEREOF:?\s*\n/i,
        /\n\(BROKER\)\s*[\u2013\u2014-]\s*GREEN LOGISTICS LLC/i,
        /\nAuthorized Signature:\s*\n/i,
    ];
    for (const re of markers) {
        const m = raw.match(re);
        if (m && typeof m.index === "number") {
            const cut = m.index;
            // Keep "IN WITNESS WHEREOF:" heading in the before section when present.
            const witness = raw.slice(cut).match(/^\s*IN WITNESS WHEREOF:?\s*/i);
            if (witness) {
                return {
                    before: raw.slice(0, cut + witness[0].length).trimEnd(),
                    after: extractPaymentTail(raw.slice(cut + witness[0].length)),
                };
            }
            return {
                before: raw.slice(0, cut).trimEnd() + "\n\nIN WITNESS WHEREOF:",
                after: extractPaymentTail(raw.slice(cut)),
            };
        }
    }
    return { before: raw.trimEnd(), after: "" };
}

function extractPaymentTail(rest: string): string {
    const m = rest.match(/\nPAYMENT OPTIONS[\s\S]*$/i);
    return m ? m[0].trim() : "";
}

function drawSignatureImage(
    doc: InstanceType<typeof PDFDocument>,
    source: string | Buffer,
    opts: { maxW?: number; maxH?: number } = {}
) {
    const maxW = opts.maxW ?? 240;
    const maxH = opts.maxH ?? 64;
    const y = doc.y;
    const x = doc.page.margins.left;
    try {
        doc.image(source, x, y, { fit: [maxW, maxH], valign: "center" });
        doc.y = y + maxH + 6;
    } catch {
        doc.fillColor("#152033").font("Times-Italic").fontSize(14).text("Spartak Kazaryan");
        doc.font("Helvetica").fontSize(9);
    }
}

/** Build Broker–Carrier Agreement PDF (full text + both signatures on the form). */
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

        const { before, after } = splitAgreementBody(input.agreementBody || "");
        doc.fontSize(8.5).font("Helvetica").fillColor("#152033").text(before, {
            align: "left",
            lineGap: 1.5,
        });

        // --- Signature blocks on the agreement form (not only a trailing page) ---
        doc.moveDown(0.6);
        if (doc.y > doc.page.height - 280) doc.addPage();

        doc.fontSize(10).font("Helvetica-Bold").fillColor("#152033").text("(BROKER) – GREEN LOGISTICS LLC");
        doc.font("Helvetica").fontSize(9).text("Authorized Signature:");
        doc.moveDown(0.2);
        const brokerSig = resolveBrokerSignaturePng();
        if (brokerSig) {
            drawSignatureImage(doc, brokerSig, { maxW: 260, maxH: 70 });
        } else {
            doc.font("Times-Italic").fontSize(16).text(BROKER_AGREEMENT_CONTACT.signerName);
            doc.font("Helvetica").fontSize(9);
        }
        doc.font("Helvetica").fontSize(9).fillColor("#152033");
        doc.text(
            `Printed Name – ${BROKER_AGREEMENT_CONTACT.signerName} / Title – ${BROKER_AGREEMENT_CONTACT.title}`
        );
        doc.text(`Company Address: ${BROKER_AGREEMENT_CONTACT.address}`);
        doc.text(`Phone – ${BROKER_AGREEMENT_CONTACT.phone}`);
        doc.text(`E-Mail ${BROKER_AGREEMENT_CONTACT.email}`);

        doc.moveDown(0.9);
        if (doc.y > doc.page.height - 200) doc.addPage();

        const carrierAddr = [input.address, input.city, input.state, input.zip]
            .filter(Boolean)
            .join(", ");
        doc.fontSize(10).font("Helvetica-Bold").text(`(CARRIER) – ${input.legalName || "CARRIER"}`);
        doc.font("Helvetica").fontSize(9).text("Authorized Signature (electronic — Green OS portal):");
        doc.moveDown(0.2);
        const carrierImg = signatureBuffer(input.signatureDataUrl);
        if (carrierImg) {
            try {
                const y = doc.y;
                doc.rect(doc.page.margins.left, y, 280, 78).stroke("#d5dde9");
                doc.image(carrierImg, doc.page.margins.left + 6, y + 6, {
                    fit: [268, 66],
                    valign: "center",
                });
                doc.y = y + 84;
            } catch {
                doc.fillColor("#5b6b84").text("(Carrier signature image could not be embedded)");
                doc.fillColor("#152033");
            }
        } else {
            doc.fillColor("#5b6b84").text("(No carrier signature image on file)");
            doc.fillColor("#152033");
        }
        doc.font("Helvetica").fontSize(9);
        doc.text(`Printed Name – ${input.signerName || input.contactName || "—"}`);
        doc.text(`Title – Authorized Signer`);
        if (carrierAddr) doc.text(`Company Address: ${carrierAddr}`);
        if (input.phone) doc.text(`Phone – ${input.phone}`);
        if (input.email || input.signerEmail) {
            doc.text(`E-Mail ${input.email || input.signerEmail}`);
        }
        doc.text(`Signed at: ${input.signedAt.toISOString()}`);

        if (after) {
            doc.moveDown(0.8);
            doc.fontSize(8.5).font("Helvetica").fillColor("#152033").text(after, {
                align: "left",
                lineGap: 1.5,
            });
        } else {
            doc.moveDown(0.8);
            doc.fontSize(9).font("Helvetica-Bold").text("PAYMENT OPTIONS (choose one in the portal):");
            doc.font("Helvetica").fontSize(8.5);
            doc.text(`Selected: ${paymentLabel(input.paymentOption)}`);
        }

        // Audit / acknowledgement page (kept for trail + large signature preview)
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

        doc.font("Helvetica-Bold").text(`BROKER — ${BROKER_AGREEMENT_CONTACT.legalName}`);
        doc.font("Helvetica").text("Authorized Signature:");
        if (brokerSig) {
            drawSignatureImage(doc, brokerSig, { maxW: 260, maxH: 70 });
        } else {
            doc.font("Times-Italic").fontSize(16).text(BROKER_AGREEMENT_CONTACT.signerName);
            doc.fontSize(10).font("Helvetica");
        }
        doc.font("Helvetica").text(
            `Printed Name: ${BROKER_AGREEMENT_CONTACT.signerName}  ·  Title: ${BROKER_AGREEMENT_CONTACT.title}`
        );
        doc.text(BROKER_AGREEMENT_CONTACT.address);
        doc.text(
            `Phone: ${BROKER_AGREEMENT_CONTACT.phone}  ·  Email: ${BROKER_AGREEMENT_CONTACT.email}`
        );
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

        if (carrierImg) {
            try {
                const y = doc.y;
                doc.rect(doc.page.margins.left, y, 280, 90).stroke("#d5dde9");
                doc.image(carrierImg, doc.page.margins.left + 8, y + 8, {
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

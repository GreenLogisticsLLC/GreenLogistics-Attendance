/** Documents shown on the Accounting shipment card. */

const LABEL: Record<string, string> = {
    RATE_CONFIRMATION: "Rate Confirmation",
    BOL: "BOL",
    POD: "POD",
    BROKER_CARRIER_AGREEMENT: "Broker–Carrier Agreement",
    MC_AUTHORITY: "MC Authority",
    NOA: "NOA/VOID CHECK-OTHER",
    W9: "W-9",
    INSURANCE: "Insurance",
    COI: "Certificate of Insurance",
    CUSTOMER_AGREEMENT: "Customer Agreement",
    CUSTOMER_INVOICE: "Customer Invoice",
    CARRIER_INVOICE: "Carrier Invoice",
    LOR: "Letter of Release",
    OTHER: "Other",
    CARRIER_PROFILE: "Carrier Profile",
    ATTACHMENT: "Attachment",
};

const ORDER = [
    "CUSTOMER_AGREEMENT",
    "RATE_CONFIRMATION",
    "BOL",
    "POD",
    "BROKER_CARRIER_AGREEMENT",
    "MC_AUTHORITY",
    "NOA",
    "W9",
    "INSURANCE",
    "COI",
    "CUSTOMER_INVOICE",
    "CARRIER_INVOICE",
    "LOR",
    "CARRIER_PROFILE",
    "OTHER",
    "ATTACHMENT",
];

/** Docs shown under Customer Documents in Accounting. */
export const CUSTOMER_DOC_TYPES = new Set([
    "CUSTOMER_AGREEMENT",
    "CUSTOMER_INVOICE",
    "CUSTOMER_PAID_PROOF",
]);

/** Generated load sheets that are not part of the carrier packet. */
const HIDDEN_LOAD_TYPES = new Set(["DISPATCH_SHEET", "LOAD_SUMMARY"]);

export type AccountingDocumentRow = {
    documentId: string;
    source: "load" | "carrier";
    /** Who uploaded / owns the file for Accounting UI. */
    uploadedBy: "Broker" | "Carrier";
    docType: string;
    label: string;
    status: string;
    fileName: string | null;
    mimeType: string;
    /** Authenticated download. Open with the login token and show inline. */
    openUrl: string | null;
};

export function accountingDocLabel(docType: string): string {
    const key = String(docType || "").toUpperCase();
    return LABEL[key] || key || "Document";
}

/** Mime the browser should use so a PDF opens in the viewer, and a photo still opens as a photo. */
export function accountingViewMime(
    mime: string | null | undefined,
    fileName: string | null | undefined,
    source: "load" | "carrier"
): string {
    const raw = String(mime || "").split(";")[0].trim().toLowerCase();
    const name = String(fileName || "");
    if (raw === "application/pdf" || raw === "application/x-pdf") return "application/pdf";
    if (raw.startsWith("image/")) return raw;
    if (/\.png$/i.test(name)) return "image/png";
    if (/\.jpe?g$/i.test(name)) return "image/jpeg";
    if (/\.webp$/i.test(name)) return "image/webp";
    if (/\.gif$/i.test(name)) return "image/gif";
    if (raw === "application/pdf" || /\.pdf$/i.test(name) || source === "load" || !raw || raw === "application/octet-stream") {
        return "application/pdf";
    }
    return raw;
}

function rank(docType: string): number {
    const i = ORDER.indexOf(String(docType || "").toUpperCase());
    return i === -1 ? ORDER.length + 1 : i;
}

export function buildAccountingDocuments(input: {
    shipmentLeadId: string;
    loadDocs: Array<{
        documentId: string;
        docType: string;
        status?: string | null;
        fileName?: string | null;
        fileUrl?: string | null;
        mimeType?: string | null;
    }>;
    carrierDocs: Array<{
        documentId: string;
        carrierId: string;
        documentType: string;
        status?: string | null;
        originalFilename?: string | null;
        mimeType?: string | null;
        uploadedBy?: string | null;
        shipmentLeadId?: string | null;
    }>;
}): AccountingDocumentRow[] {
    const loadRows: AccountingDocumentRow[] = [];
    const loadTypesWithFile = new Set<string>();
    for (const doc of input.loadDocs) {
        const docType = String(doc.docType || "").toUpperCase();
        if (HIDDEN_LOAD_TYPES.has(docType)) continue;
        const hasFile = Boolean(doc.fileUrl);
        if (hasFile) loadTypesWithFile.add(docType);
        const fileName = doc.fileName || null;
        loadRows.push({
            documentId: doc.documentId,
            source: "load",
            uploadedBy: "Broker",
            docType,
            label: accountingDocLabel(docType),
            status: doc.status || "",
            fileName,
            mimeType: accountingViewMime(doc.mimeType, fileName, "load"),
            openUrl: hasFile
                ? `/api/loads/${input.shipmentLeadId}/documents/${doc.documentId}/download?inline=1`
                : null,
        });
    }

    const seen = new Set<string>();
    const carrierRows: AccountingDocumentRow[] = [];
    for (const doc of input.carrierDocs) {
        if (seen.has(doc.documentId)) continue;
        seen.add(doc.documentId);
        const docType = String(doc.documentType || "").toUpperCase();
        // Prefer the load's own Rate Confirmation / BOL / POD file when both exist.
        if (
            loadTypesWithFile.has(docType) &&
            (docType === "RATE_CONFIRMATION" || docType === "BOL" || docType === "POD")
        ) {
            continue;
        }
        const fileName = doc.originalFilename || null;
        const who = String(doc.uploadedBy || "CARRIER").toUpperCase();
        carrierRows.push({
            documentId: doc.documentId,
            source: "carrier",
            uploadedBy: who === "BROKER" || who === "USER" ? "Broker" : "Carrier",
            docType,
            label: accountingDocLabel(docType),
            status: String(doc.status || "").toUpperCase() === "CURRENT" ? "Uploaded" : doc.status || "Uploaded",
            fileName,
            mimeType: accountingViewMime(doc.mimeType, fileName, "carrier"),
            openUrl: `/api/carriers/${doc.carrierId}/documents/${doc.documentId}/download?inline=1`,
        });
    }

    const hasCustomerAgreement = loadRows.some(
        (row) => String(row.docType || "").toUpperCase() === "CUSTOMER_AGREEMENT"
    );
    if (!hasCustomerAgreement) {
        loadRows.push({
            documentId: "",
            source: "load",
            uploadedBy: "Broker",
            docType: "CUSTOMER_AGREEMENT",
            label: accountingDocLabel("CUSTOMER_AGREEMENT"),
            status: "",
            fileName: null,
            mimeType: "application/pdf",
            openUrl: null,
        });
    }

    return [...loadRows, ...carrierRows].sort(
        (a, b) => rank(a.docType) - rank(b.docType) || a.label.localeCompare(b.label)
    );
}

export function isCustomerAccountingDoc(docType: string): boolean {
    return CUSTOMER_DOC_TYPES.has(String(docType || "").toUpperCase());
}

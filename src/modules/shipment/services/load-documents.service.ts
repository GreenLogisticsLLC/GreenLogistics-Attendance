import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database.js";
import { domainEventEngine } from "./domain-event.engine.js";
import {
    LOAD_DOC_CHANGE_LABELS,
    LOAD_DOC_TYPE_LABELS,
    LOAD_DOC_TYPES,
    type LoadDocType,
} from "../load.constants.js";
import {
    DEFAULT_RATE_CON_TERMS,
    generateLoadDocumentPdf,
    LOAD_DOCS_ROOT,
    type LoadDocumentContent,
} from "./load-pdf.service.js";
import {
    assertQuickActionAllowed,
    quickActionIdForDocType,
} from "../load-quick-actions.js";
import { buildCarrierOperationalSummary } from "../../ai/operational/carrier-context.js";
import { documentAiJobService } from "../../ai/documents/job.service.js";
import type { CarrierOperationalSummary } from "../../ai/operational/types.js";

export function assertRateConfirmationCompliance(
    summary: Pick<CarrierOperationalSummary, "readiness" | "compliance">,
    acknowledged: boolean
) {
    if (summary.readiness === "NOT_READY" || summary.compliance.light === "RED") {
        throw Object.assign(
            new Error(
                `Cannot generate Rate Confirmation: carrier compliance is ${summary.compliance.light} (${summary.readiness}).`
            ),
            { status: 422, code: "RC_COMPLIANCE_BLOCKED" }
        );
    }
    if (summary.readiness === "REVIEW_REQUIRED" && !acknowledged) {
        throw Object.assign(
            new Error(
                "Carrier compliance requires review. Acknowledge the compliance review before generating the Rate Confirmation."
            ),
            { status: 422, code: "RC_COMPLIANCE_ACK_REQUIRED" }
        );
    }
}

export function enqueueLoadDocumentAi(
    input: Parameters<typeof documentAiJobService.enqueue>[0],
    enqueue: (value: Parameters<typeof documentAiJobService.enqueue>[0]) => Promise<unknown> =
        (value) => documentAiJobService.enqueue(value)
) {
    void enqueue(input).catch((err) =>
        console.warn(`[doc-ai] enqueue failed for ${input.documentId}`, err)
    );
}

function fmtDate(d?: Date | null) {
    if (!d) return null;
    try {
        return new Date(d).toLocaleDateString();
    } catch {
        return null;
    }
}

function fmtTime(d?: Date | null) {
    if (!d) return null;
    try {
        return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
        return null;
    }
}

function assertDocType(docType: string): LoadDocType {
    const t = String(docType || "").toUpperCase();
    if (!(LOAD_DOC_TYPES as readonly string[]).includes(t)) {
        throw Object.assign(new Error(`Unsupported document type: ${docType}`), { status: 422 });
    }
    return t as LoadDocType;
}

function place(city?: string | null, state?: string | null, zip?: string | null) {
    return [city, state, zip].filter(Boolean).join(", ") || null;
}

function fmtWindow(from?: Date | null, to?: Date | null) {
    const parts: string[] = [];
    if (from) parts.push(new Date(from).toLocaleString());
    if (to) parts.push(new Date(to).toLocaleString());
    return parts.length ? parts.join(" → ") : null;
}

export class LoadDocumentsService {
    /** Build editable content snapshot from the Load (ShipmentLead). */
    async buildContentFromLoad(shipmentLeadId: string): Promise<LoadDocumentContent> {
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw Object.assign(new Error("Load not found"), { status: 404 });
        if (!s.loadNumber) {
            throw Object.assign(new Error("Documents require a Load Number on this card"), { status: 422 });
        }

        let brokerName: string | null = null;
        let brokerEmail: string | null = null;
        if (s.assignedBrokerId) {
            const u = await prisma.user.findUnique({
                where: { userId: s.assignedBrokerId },
                select: { firstName: true, lastName: true, email: true },
            });
            brokerName =
                [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.email || null;
            const gmail = await prisma.brokerGmailAccount.findUnique({
                where: { userId: s.assignedBrokerId },
                select: { gmailAddress: true, isActive: true },
            });
            brokerEmail =
                (gmail?.isActive !== false && gmail?.gmailAddress) || u?.email || null;
        }

        const pickupAt = s.opsPickupAt || s.pickupFrom;
        const deliveryAt = s.opsDeliveryAt || s.deliveryFrom;

        return {
            loadNumber: s.loadNumber,
            shipmentNumber: s.greenOsShipmentId,
            referenceNumber: s.externalShipmentId,
            customerName: s.customerName,
            customerEmail: s.customerEmail,
            brokerName,
            brokerEmail,
            carrierName: s.carrierName,
            carrierEmail: s.carrierEmail,
            carrierMc: s.carrierMc,
            carrierDot: s.carrierDot,
            carrierPhone: s.carrierPhone,
            driverName: s.driverName,
            driverPhone: s.driverPhone,
            truckNumber: s.truckNumber,
            trailerNumber: s.trailerNumber,
            pickupAddress: place(s.pickupCity, s.pickupState, s.pickupZip),
            deliveryAddress: place(s.deliveryCity, s.deliveryState, s.deliveryZip),
            pickupWindow: fmtWindow(s.pickupFrom, s.pickupTo),
            deliveryWindow: fmtWindow(s.deliveryFrom, s.deliveryTo),
            pickupDate: fmtDate(pickupAt),
            pickupTime: fmtTime(pickupAt),
            pickupContact: null,
            deliveryDate: fmtDate(deliveryAt),
            deliveryTime: fmtTime(deliveryAt),
            deliveryContact: null,
            equipment: s.equipment,
            commodity: s.commodity || s.vehicle || s.category,
            weight: s.weight,
            pieces: s.pieces,
            miles: s.miles,
            customerRate: s.customerRate ?? s.price,
            carrierRate: s.carrierRate,
            flatRate: s.carrierRate,
            paymentOption: s.paymentStatus || null,
            deliveryNote: s.carrierNotes || null,
            specialNotes: s.specialInstructions || s.notes,
            confirmationDate: new Date().toLocaleDateString(),
            terms: DEFAULT_RATE_CON_TERMS,
            specialInstructions: s.specialInstructions || s.notes,
            bolNumber: s.loadNumber,
            freightTerms: "PREPAID",
            customerOrderNo: s.externalShipmentId,
            packageQty: s.pieces,
            handlingQty: s.pieces,
            deliveredInGoodOrder: true,
            invoiceNumber: s.invoiceNumber || (s.loadNumber ? String(s.loadNumber).replace(/^GL/i, "") : null),
            invoiceDate: s.invoiceDate
                ? new Date(s.invoiceDate).toLocaleDateString()
                : new Date().toLocaleDateString(),
            billToName: s.customerName,
            billToEmail: s.customerEmail,
            billToPhone: s.customerPhone,
            billToAddress: null,
            invoiceDescription: [
                "Freight transportation",
                place(s.pickupCity, s.pickupState, s.pickupZip) &&
                place(s.deliveryCity, s.deliveryState, s.deliveryZip)
                    ? `${place(s.pickupCity, s.pickupState, s.pickupZip)} → ${place(s.deliveryCity, s.deliveryState, s.deliveryZip)}`
                    : "",
                s.commodity || s.vehicle || s.category || "",
            ]
                .filter(Boolean)
                .join(" · "),
            invoiceHours: 1,
            invoiceRatePerHour: s.customerRate ?? s.price,
            invoiceLineTotal: s.customerRate ?? s.price,
            invoiceSubtotal: s.customerRate ?? s.price,
            taxRate: 0,
            taxAmount: 0,
            totalAmountDue: s.customerRate ?? s.price,
            paymentTerms: "Net 30",
            invoiceTerms:
                "Payment is due per the terms stated on this invoice. Please reference Load # on all remittances. Questions: info@greengrouplogistics.com or greenlogisticsllc20@gmail.com.",
            sendPaymentTo:
                "BANK OF AMERICA\n121 FROG HOLLOW RD\nSOUTHAMPTON PA 18966\nGreen Logistics LLC",
        };
    }

    async listCurrent(shipmentLeadId: string) {
        return prisma.loadDocument.findMany({
            where: { shipmentLeadId, isCurrent: true, status: { not: "ARCHIVED" } },
            orderBy: [{ docType: "asc" }, { version: "desc" }],
        });
    }

    async history(shipmentLeadId: string, docType: string) {
        const t = assertDocType(docType);
        return prisma.loadDocument.findMany({
            where: { shipmentLeadId, docType: t },
            orderBy: { version: "desc" },
        });
    }

    async getById(documentId: string) {
        const row = await prisma.loadDocument.findUnique({ where: { documentId } });
        if (!row) throw Object.assign(new Error("Document not found"), { status: 404 });
        return row;
    }

    /**
     * Generate a new document version from the Load (or edited content).
     * Never overwrites prior versions.
     */
    async generate(input: {
        shipmentLeadId: string;
        docType: string;
        actorUserId?: string;
        actorRole?: string;
        acknowledgeComplianceReview?: boolean;
        contentOverrides?: Partial<LoadDocumentContent>;
        changeReason?: string;
        advanceStatus?: string | null;
    }) {
        const docType = assertDocType(input.docType);
        if (docType === "DISPATCH_SHEET" || docType === "LOAD_SUMMARY") {
            throw Object.assign(
                new Error("Dispatch Sheet and Load Summary are no longer used on Loads"),
                { status: 422, code: "DOC_TYPE_REMOVED" }
            );
        }
        if (docType === "CUSTOMER_PAID_PROOF" || docType === "CARRIER_PAID_PROOF") {
            throw Object.assign(
                new Error("Upload a payment document instead of generating a PDF"),
                { status: 422 }
            );
        }
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
        });
        if (!lead) throw Object.assign(new Error("Load not found"), { status: 404 });
        if (!lead.loadNumber) {
            throw Object.assign(new Error("Create Load first — documents belong only to a Load"), {
                status: 422,
            });
        }

        if (docType === "RATE_CONFIRMATION" && lead.carrierProfileId) {
            const actorUserId = input.actorUserId || lead.assignedBrokerId;
            if (!actorUserId) {
                throw Object.assign(
                    new Error("Cannot verify carrier compliance without an assigned broker"),
                    { status: 422, code: "RC_COMPLIANCE_ACTOR_REQUIRED" }
                );
            }
            const summary = await buildCarrierOperationalSummary(
                { userId: actorUserId, role: input.actorRole || "Broker" },
                lead.carrierProfileId
            );
            assertRateConfirmationCompliance(
                summary,
                input.acknowledgeComplianceReview === true
            );
        }

        const existingDocs = await prisma.loadDocument.findMany({
            where: {
                shipmentLeadId: input.shipmentLeadId,
                isCurrent: true,
                status: { not: "ARCHIVED" },
            },
            select: { docType: true, contentJson: true },
        });
        const actionId = quickActionIdForDocType(docType);
        if (actionId) {
            let carrierOnboardingStatus: string | null = null;
            if (lead.carrierProfileId) {
                const profile = await prisma.carrier.findUnique({
                    where: { carrierId: lead.carrierProfileId },
                    select: { onboardingStatus: true },
                });
                carrierOnboardingStatus = profile?.onboardingStatus || null;
            }
            assertQuickActionAllowed(actionId, {
                status: lead.status,
                carrierName: lead.carrierName,
                carrierOnboardingStatus,
                documents: existingDocs,
            });
        }

        const base = await this.buildContentFromLoad(input.shipmentLeadId);
        const content: LoadDocumentContent = { ...base, ...(input.contentOverrides || {}) };

        if (docType === "RATE_CONFIRMATION") {
            const required: Array<[string, unknown]> = [
                ["Customer email", content.customerEmail],
                ["Carrier", content.carrierName],
                ["Carrier email", content.carrierEmail],
                ["Weight", content.weight],
                ["Commodity", content.commodity],
                ["Flat Rate", content.flatRate ?? content.carrierRate],
                ["Origin (pickup address)", content.pickupAddress],
                ["Pickup date", content.pickupDate],
                ["Final destination", content.deliveryAddress],
                ["Delivery date", content.deliveryDate],
            ];
            const missing = required
                .filter(([, v]) => v == null || String(v).trim() === "")
                .map(([label]) => label);
            if (missing.length) {
                throw Object.assign(
                    new Error(`Rate Confirmation requires: ${missing.join(", ")}`),
                    { status: 422, code: "RC_REQUIRED_FIELDS" }
                );
            }
        }

        if (docType === "BOL") {
            const required: Array<[string, unknown]> = [
                ["SHIPS FROM (origin)", content.pickupAddress],
                ["SHIPS TO (destination)", content.deliveryAddress],
                ["Weight", content.weight],
            ];
            const missing = required
                .filter(([, v]) => v == null || String(v).trim() === "")
                .map(([label]) => label);
            if (missing.length) {
                throw Object.assign(
                    new Error(`BOL requires: ${missing.join(", ")}`),
                    { status: 422, code: "BOL_REQUIRED_FIELDS" }
                );
            }
        }

        const last = await prisma.loadDocument.findFirst({
            where: { shipmentLeadId: input.shipmentLeadId, docType },
            orderBy: { version: "desc" },
        });
        const version = (last?.version || 0) + 1;
        const changeReason = input.changeReason || (version === 1 ? "GENERATED" : "BROKER_EDITED");

        if (last?.isCurrent) {
            await prisma.loadDocument.update({
                where: { documentId: last.documentId },
                data: { isCurrent: false },
            });
        }

        const pdf = await generateLoadDocumentPdf({
            shipmentLeadId: input.shipmentLeadId,
            docType,
            version,
            content,
        });

        const title = `${LOAD_DOC_TYPE_LABELS[docType] || docType} v${version}`;
        const row = await prisma.loadDocument.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                docType,
                version,
                changeReason,
                title,
                status: "READY",
                isCurrent: true,
                contentJson: JSON.stringify(content),
                fileName: pdf.fileName,
                mimeType: pdf.mimeType,
                storedName: pdf.storedName,
                fileUrl: pdf.fileUrl,
                fileSize: pdf.fileSize,
                createdById: input.actorUserId || null,
            },
        });

        const reasonLabel = LOAD_DOC_CHANGE_LABELS[changeReason] || changeReason;
        const eventType =
            docType === "RATE_CONFIRMATION"
                ? changeReason === "GENERATED"
                    ? "RATE_CONFIRMATION_GENERATED"
                    : "RATE_CONFIRMATION_EDITED"
                : docType === "BOL"
                  ? changeReason === "GENERATED"
                      ? "BOL_GENERATED"
                      : "BOL_EDITED"
                  : docType === "CUSTOMER_INVOICE"
                    ? "CUSTOMER_INVOICE_GENERATED"
                    : docType === "CARRIER_INVOICE"
                      ? "CARRIER_INVOICE_GENERATED"
                      : docType === "POD"
                        ? "POD_UPLOADED"
                        : changeReason === "GENERATED"
                          ? "DOCUMENT_GENERATED"
                          : "DOCUMENT_EDITED";

        await domainEventEngine.emit({
            shipmentLeadId: input.shipmentLeadId,
            eventType,
            title: `${title} (${reasonLabel})`,
            message: `${title} saved on Load ${lead.loadNumber}`,
            actorUserId: input.actorUserId,
            payload: {
                documentId: row.documentId,
                docType,
                version,
                changeReason,
                fileUrl: row.fileUrl,
            },
            timelineStage:
                docType === "RATE_CONFIRMATION"
                    ? "RATE_CONFIRMATION_GENERATED"
                    : docType === "POD"
                      ? "POD_UPLOADED"
                      : docType === "CUSTOMER_INVOICE"
                        ? "CUSTOMER_INVOICE_GENERATED"
                        : "LOAD_CREATED",
        });

        if (
            (docType === "RATE_CONFIRMATION" || docType === "BOL") &&
            (input.actorUserId || lead.assignedBrokerId)
        ) {
            enqueueLoadDocumentAi({
                actor: {
                    userId: input.actorUserId || lead.assignedBrokerId!,
                    role: input.actorRole || "Broker",
                },
                documentSource: "LOAD",
                documentId: row.documentId,
            });
        }

        if (input.advanceStatus) {
            const { shipmentService } = await import("./shipment.service.js");
            await shipmentService.transitionStatus({
                shipmentLeadId: input.shipmentLeadId,
                status: input.advanceStatus,
                actorUserId: input.actorUserId,
                skipLifecycleCheck: false,
            });
        } else {
            const { shipmentService } = await import("./shipment.service.js");
            const tryAdvance = async (status: string) => {
                try {
                    await shipmentService.transitionStatus({
                        shipmentLeadId: input.shipmentLeadId,
                        status,
                        actorUserId: input.actorUserId,
                    });
                } catch {
                    /* allow generate without forcing status if transition blocked */
                }
            };

            // Keep the left rail in sync with real docs (Rate Con / POD / Invoice).
            if (docType === "RATE_CONFIRMATION" && version === 1) {
                await tryAdvance("RATE_CON_GENERATED");
            } else if (docType === "POD") {
                await tryAdvance("POD_UPLOADED");
            } else if (docType === "CUSTOMER_INVOICE") {
                // If still at Delivered, move through POD first when a POD already exists.
                const pod = await prisma.loadDocument.findFirst({
                    where: {
                        shipmentLeadId: input.shipmentLeadId,
                        docType: "POD",
                        isCurrent: true,
                    },
                    select: { documentId: true },
                });
                if (pod) await tryAdvance("POD_UPLOADED");
                await tryAdvance("CUSTOMER_INVOICE");
                // Invoice # only — Customer/Carrier $ are set by Accounting/Owner in Money section.
                if (content.invoiceNumber) {
                    await prisma.shipmentLead
                        .update({
                            where: { shipmentLeadId: input.shipmentLeadId },
                            data: {
                                invoiceNumber: String(content.invoiceNumber),
                                invoiceDate: content.invoiceDate
                                    ? new Date(String(content.invoiceDate))
                                    : new Date(),
                            },
                        })
                        .catch(() => null);
                }
            }
            // Rate Con Flat Rate stays on the PDF content only.
            // Books (carrierRate / customerRate / profit) = Accounting + Owner.
        }

        return row;
    }

    /** Edit content → new version + regenerate PDF (never overwrite). */
    async edit(input: {
        shipmentLeadId: string;
        docType: string;
        content: Partial<LoadDocumentContent>;
        changeReason?: string;
        actorUserId?: string;
        actorRole?: string;
        acknowledgeComplianceReview?: boolean;
    }) {
        return this.generate({
            shipmentLeadId: input.shipmentLeadId,
            docType: input.docType,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            acknowledgeComplianceReview: input.acknowledgeComplianceReview,
            contentOverrides: input.content,
            changeReason: input.changeReason || "BROKER_EDITED",
        });
    }

    async archive(documentId: string, actorUserId?: string) {
        const row = await this.getById(documentId);
        const updated = await prisma.loadDocument.update({
            where: { documentId },
            data: { status: "ARCHIVED", isCurrent: false, changeReason: "ARCHIVED" },
        });
        await domainEventEngine.emit({
            shipmentLeadId: row.shipmentLeadId,
            eventType: "DOCUMENT_ARCHIVED",
            title: `${row.title} archived`,
            message: `Document archived on Load`,
            actorUserId,
            payload: { documentId, docType: row.docType, version: row.version },
            timelineStage: "LOAD_CREATED",
        });
        return updated;
    }

    async markSent(documentId: string, actorUserId?: string) {
        const row = await this.getById(documentId);
        const updated = await prisma.loadDocument.update({
            where: { documentId },
            data: { status: "SENT" },
        });
        const eventType =
            row.docType === "RATE_CONFIRMATION"
                ? "RATE_CONFIRMATION_SENT"
                : row.docType === "CUSTOMER_INVOICE"
                  ? "CUSTOMER_INVOICE_SENT"
                  : "DOCUMENT_SENT";
        await domainEventEngine.emit({
            shipmentLeadId: row.shipmentLeadId,
            eventType,
            title: `${row.title} sent`,
            message: `Document emailed / sent from Load`,
            actorUserId,
            payload: { documentId, docType: row.docType, version: row.version, fileUrl: row.fileUrl },
            timelineStage:
                row.docType === "RATE_CONFIRMATION" ? "RATE_CONFIRMATION_GENERATED" : "LOAD_CREATED",
        });
        return updated;
    }

    /** Store an uploaded Customer Paid / Carrier Paid proof on the Load. */
    async uploadProof(input: {
        shipmentLeadId: string;
        docType: string;
        actorUserId?: string;
        originalName: string;
        mimeType: string;
        tempPath: string;
    }) {
        const docType = assertDocType(input.docType);
        if (docType !== "CUSTOMER_PAID_PROOF" && docType !== "CARRIER_PAID_PROOF") {
            throw Object.assign(new Error("This upload is only for payment proof documents"), {
                status: 422,
            });
        }
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
        });
        if (!lead) throw Object.assign(new Error("Load not found"), { status: 404 });
        if (!lead.loadNumber) {
            throw Object.assign(new Error("Create Load first — documents belong only to a Load"), {
                status: 422,
            });
        }
        if (!input.tempPath || !fs.existsSync(input.tempPath)) {
            throw Object.assign(new Error("Uploaded file is missing"), { status: 400 });
        }

        const last = await prisma.loadDocument.findFirst({
            where: { shipmentLeadId: input.shipmentLeadId, docType },
            orderBy: { version: "desc" },
        });
        const version = (last?.version || 0) + 1;
        if (last?.isCurrent) {
            await prisma.loadDocument.update({
                where: { documentId: last.documentId },
                data: { isCurrent: false },
            });
        }

        const ext = path.extname(input.originalName || "").toLowerCase() || ".bin";
        const storedName = `${docType}_v${version}_${Date.now()}${ext}`;
        const dir = path.join(LOAD_DOCS_ROOT, input.shipmentLeadId);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, storedName);
        fs.copyFileSync(input.tempPath, dest);
        try {
            fs.unlinkSync(input.tempPath);
        } catch {
            /* ignore temp cleanup */
        }
        const stat = fs.statSync(dest);
        const fileName = path.basename(input.originalName || storedName);
        const title = `${LOAD_DOC_TYPE_LABELS[docType] || docType} v${version}`;

        const row = await prisma.loadDocument.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                docType,
                version,
                changeReason: version === 1 ? "UPLOADED" : "REPLACED",
                title,
                status: "READY",
                isCurrent: true,
                fileName,
                mimeType: input.mimeType || "application/octet-stream",
                storedName,
                fileUrl: `/api/loads/${input.shipmentLeadId}/documents/file/${storedName}`,
                fileSize: stat.size,
                createdById: input.actorUserId || null,
            },
        });

        await domainEventEngine.emit({
            shipmentLeadId: input.shipmentLeadId,
            eventType: "DOCUMENT_GENERATED",
            title: `${title} uploaded`,
            message: `${title} saved on Load ${lead.loadNumber}`,
            actorUserId: input.actorUserId,
            payload: {
                documentId: row.documentId,
                docType,
                version,
                fileName,
            },
            timelineStage: "LOAD_CREATED",
        });
        return row;
    }
}

export const loadDocumentsService = new LoadDocumentsService();

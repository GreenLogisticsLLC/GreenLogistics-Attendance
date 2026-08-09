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
    type LoadDocumentContent,
} from "./load-pdf.service.js";

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
            carrierPhone: null,
            driverName: s.driverName,
            driverPhone: null,
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
        contentOverrides?: Partial<LoadDocumentContent>;
        changeReason?: string;
        advanceStatus?: string | null;
    }) {
        const docType = assertDocType(input.docType);
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
        });
        if (!lead) throw Object.assign(new Error("Load not found"), { status: 404 });
        if (!lead.loadNumber) {
            throw Object.assign(new Error("Create Load first — documents belong only to a Load"), {
                status: 422,
            });
        }

        const base = await this.buildContentFromLoad(input.shipmentLeadId);
        const content: LoadDocumentContent = { ...base, ...(input.contentOverrides || {}) };

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
                const customerAmt = (() => {
                    const raw =
                        content.totalAmountDue ??
                        content.invoiceLineTotal ??
                        content.invoiceSubtotal ??
                        content.customerRate;
                    if (raw == null || raw === "") return null;
                    const n =
                        typeof raw === "number"
                            ? raw
                            : Number(String(raw).replace(/[^0-9.-]/g, ""));
                    return Number.isFinite(n) ? n : null;
                })();
                await prisma.shipmentLead
                    .update({
                        where: { shipmentLeadId: input.shipmentLeadId },
                        data: {
                            ...(content.invoiceNumber
                                ? {
                                      invoiceNumber: String(content.invoiceNumber),
                                      invoiceDate: content.invoiceDate
                                          ? new Date(String(content.invoiceDate))
                                          : new Date(),
                                  }
                                : {}),
                            ...(customerAmt != null && customerAmt > 0
                                ? { customerRate: customerAmt }
                                : {}),
                        },
                    })
                    .catch(() => null);
            } else if (docType === "RATE_CONFIRMATION") {
                const rateRaw = content.flatRate ?? content.carrierRate;
                if (rateRaw != null && rateRaw !== "") {
                    const n =
                        typeof rateRaw === "number"
                            ? rateRaw
                            : Number(String(rateRaw).replace(/[^0-9.-]/g, ""));
                    if (Number.isFinite(n) && n > 0) {
                        await prisma.shipmentLead
                            .update({
                                where: { shipmentLeadId: input.shipmentLeadId },
                                data: { carrierRate: n },
                            })
                            .catch(() => null);
                    }
                }
            }
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
    }) {
        return this.generate({
            shipmentLeadId: input.shipmentLeadId,
            docType: input.docType,
            actorUserId: input.actorUserId,
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
}

export const loadDocumentsService = new LoadDocumentsService();

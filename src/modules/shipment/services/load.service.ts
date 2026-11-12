import { prisma } from "../../../config/database.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { shipmentService } from "./shipment.service.js";
import { loadDocumentsService } from "./load-documents.service.js";
import { platformNotificationService } from "./platform-notification.service.js";
import { LOAD_DOC_CHANGE_LABELS, TRACKING_STEPS } from "../load.constants.js";
import { isLoadPhase, normalizeStatus, statusLabel } from "../shipment.lifecycle.js";
import { allocateLoadNumber } from "../load-number.js";
import { allocateGreenOsShipmentId } from "../shipment.id.js";
import { Roles } from "../../../auth/roles.js";
import {
    assertQuickActionAllowed,
    roleSkipsLoadGates,
    buildLoadQuickActions,
    isCustomerInfoReady,
} from "../load-quick-actions.js";
import { isLoadCarrierApproved } from "../load-carrier-review.js";
import { buildLoadCarrierReviewPacket } from "./load-carrier-review.service.js";
import { sendLoadReviewEmail } from "./load-review-email.service.js";
import { shipmentLifecycleService } from "../../ai/lifecycle/service.js";
import { carrierPaymentOptionLabel } from "../../carriers/constants.js";
import { isNameAndEmailCarrierChange } from "../../carriers/carrier-superseded.js";
import {
    appendCarrierHistory,
    parseCarrierHistory,
    statusAfterUnvoid,
} from "../carrier-history.js";
import {
    canWaiveCustomerPaymentFee,
    customerPaymentQuote,
    normalizeCustomerPaymentMethod,
} from "../customer-payment.js";
import { carrierMissingOnPickup } from "../carrier-missing-on-pickup.js";
import { config } from "../../../config/env.js";
import { AccountingDocStatus } from "../../accounting/accounting.constants.js";
import { customerService } from "../../customers/services/customer.service.js";
import {
    carrierAmountFromRateConContent,
    customerAmountFromInvoiceContent,
    parseMoneyValue,
    preferRateConCarrierAmount,
} from "../load-amounts.js";

export {
    carrierAmountFromRateConContent,
    customerAmountFromInvoiceContent,
    preferRateConCarrierAmount,
} from "../load-amounts.js";

function money(n: number | null | undefined): number {
    return Number.isFinite(n as number) ? Number(n) : 0;
}

function looksLikeEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

/**
 * Company profit on a Load:
 *   From customer (взяли) − To carrier (отдали по carrier invoice / Rate Con)
 * Extra fees are tracked separately and do NOT change this profit formula.
 */
export function computePricing(row: {
    price?: number | null;
    customerRate?: number | null;
    carrierRate?: number | null;
    fuelSurcharge?: number | null;
    accessorialCharges?: number | null;
    factoringFee?: number | null;
}) {
    // What we bill / take from the customer (Customer Invoice amount).
    const fromCustomer = money(row.customerRate ?? row.price);
    // What we pay the carrier (Rate Con flat rate / Carrier Invoice).
    const toCarrier = money(row.carrierRate);
    const fuel = money(row.fuelSurcharge);
    const accessorials = money(row.accessorialCharges);
    const factoring = money(row.factoringFee);
    const profit = fromCustomer - toCarrier;
    const marginPct = fromCustomer > 0 ? (profit / fromCustomer) * 100 : 0;
    return {
        customerRate: fromCustomer,
        carrierRate: toCarrier,
        fromCustomer,
        toCarrier,
        fuelSurcharge: fuel,
        accessorialCharges: accessorials,
        factoringFee: factoring,
        totalRevenue: fromCustomer,
        totalCost: toCarrier,
        grossProfit: profit,
        profit,
        marginPct: Math.round(marginPct * 100) / 100,
        companyProfit: profit,
        brokerProfit: profit,
        hasCustomerPrice: row.customerRate != null || row.price != null,
        hasCarrierPrice: row.carrierRate != null,
        hasBothSides:
            (row.customerRate != null || row.price != null) && row.carrierRate != null,
    };
}

function trackingFromStatus(status: string, trackingStatus?: string | null) {
    const n = normalizeStatus(status);
    const explicit = String(trackingStatus || "").toUpperCase();
    const order = TRACKING_STEPS.map((s) => s.id);
    let current = explicit && order.includes(explicit as (typeof order)[number]) ? explicit : "ASSIGNED";
    if (!explicit) {
        if (["CARRIER_ASSIGNED", "RATE_CON_GENERATED", "LOAD_CREATED"].includes(n)) current = "ASSIGNED";
        if (["CARRIER_ACCEPTED", "DISPATCH"].includes(n)) current = "DISPATCHED";
        if (n === "PICKUP") current = "LOADED";
        if (n === "IN_TRANSIT") current = "IN_TRANSIT";
        if (["DELIVERED", "POD_UPLOADED"].includes(n)) current = "DELIVERED";
        if (["CUSTOMER_INVOICE", "CARRIER_PAYMENT", "COMPLETED", "CLOSED"].includes(n)) current = "COMPLETED";
    }
    const idx = order.indexOf(current as (typeof order)[number]);
    return {
        current,
        steps: TRACKING_STEPS.map((s, i) => ({
            ...s,
            done: i <= idx,
            active: i === idx,
        })),
    };
}

export class LoadService {
    /**
     * Auto-create Load Number only. Brokers cannot supply a custom number.
     */
    async createLoad(
        shipmentLeadId: string,
        actorUserId?: string,
        options?: { customerRate?: number | null }
    ) {
        const shipment = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!shipment) throw Object.assign(new Error("Shipment not found"), { status: 404 });

        let rateToSave: number | undefined;
        if (options?.customerRate !== undefined && options?.customerRate !== null) {
            const n = Number(options.customerRate);
            if (!Number.isFinite(n) || n < 0) {
                throw Object.assign(new Error("Customer rate must be a non-negative number"), {
                    status: 422,
                });
            }
            rateToSave = n;
        }

        if (shipment.loadNumber && String(shipment.loadNumber).trim()) {
            // Load already exists — still allow broker to set customer rate if provided.
            if (rateToSave !== undefined) {
                await prisma.shipmentLead.update({
                    where: { shipmentLeadId },
                    data: {
                        customerRate: rateToSave,
                        price: rateToSave,
                    },
                });
            }
            return shipmentService.createLoadAfterAccepted({ shipmentLeadId, actorUserId });
        }
        const loadNumber = await allocateLoadNumber();
        return shipmentService.applyLoadNumber({
            shipmentLeadId,
            loadNumber,
            actorUserId,
            ...(rateToSave !== undefined ? { customerRate: rateToSave } : {}),
        });
    }

    /**
     * Create Load Step 1 (uShip / Booking Confirmation): save customer contact,
     * ensure GL#, optionally email agreement + load number (Direct Create Load parity).
     */
    async saveCustomerSetup(
        shipmentLeadId: string,
        body: Record<string, unknown>,
        actor: { userId: string; role: string }
    ) {
        const shipment = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!shipment) throw Object.assign(new Error("Load not found"), { status: 404 });

        const customerName =
            body.customerName == null ? "" : String(body.customerName).trim();
        const customerEmail =
            body.customerEmail == null || body.customerEmail === ""
                ? null
                : String(body.customerEmail).trim();
        const customerPhone =
            body.customerPhone == null || body.customerPhone === ""
                ? null
                : String(body.customerPhone).trim();

        if (customerName.length < 2) {
            throw Object.assign(new Error("Customer name is required"), { status: 422 });
        }
        const phoneDigits = String(customerPhone || "").replace(/\D/g, "");
        if (!(customerEmail && customerEmail.includes("@")) && phoneDigits.length < 10) {
            throw Object.assign(
                new Error("Enter customer email or a valid phone number"),
                { status: 422 }
            );
        }

        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                customerName,
                customerEmail,
                customerPhone,
            },
        });

        if (!shipment.loadNumber || !String(shipment.loadNumber).trim()) {
            await this.createLoad(shipmentLeadId, actor.userId);
        }

        const emails = await customerService.sendLoadCustomerSetupEmails(
            shipmentLeadId,
            {
                customerName,
                customerEmail,
                customerPhone,
                sendLoadNumber: body.sendLoadNumber,
                agreementType: body.agreementType,
                sendAgreement: body.sendAgreement,
            },
            actor
        );

        const details = await this.getLoadDetails(shipmentLeadId, {
            actorRole: actor.role,
        });
        return {
            ...details,
            loadNumberEmail: emails.loadNumberEmail,
            agreementEmail: emails.agreementEmail,
        };
    }

    async listLoads(filter: {
        phase: "active" | "completed" | "voided" | "all";
        limit?: number;
        brokerId?: string;
    }) {
        const limit = Math.min(filter.limit || 100, 300);
        const activeStatuses = [
            "LOAD_CREATED",
            "CARRIER_ASSIGNED",
            "RATE_CON_GENERATED",
            "CARRIER_ACCEPTED",
            "PICKUP",
            "IN_TRANSIT",
            "DELIVERED",
            "POD_UPLOADED",
            "CUSTOMER_INVOICE",
            "CARRIER_PAYMENT",
            "DISPATCH",
        ];
        const completedStatuses = ["COMPLETED", "CLOSED"];

        const where: Record<string, unknown> =
            filter.phase === "active"
                ? { loadNumber: { not: null }, status: { in: activeStatuses } }
                : filter.phase === "completed"
                  ? { loadNumber: { not: null }, status: { in: completedStatuses } }
                  : filter.phase === "voided"
                    ? { loadNumber: { not: null }, status: "VOIDED" }
                    : { loadNumber: { not: null }, status: { not: "VOIDED" } };
        if (filter.brokerId) where.assignedBrokerId = filter.brokerId;

        const rows = await prisma.shipmentLead.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: limit,
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                status: true,
                customerName: true,
                carrierName: true,
                pickupCity: true,
                pickupState: true,
                deliveryCity: true,
                deliveryState: true,
                customerRate: true,
                carrierRate: true,
                fuelSurcharge: true,
                accessorialCharges: true,
                factoringFee: true,
                price: true,
                updatedAt: true,
                createdAt: true,
                pickupFrom: true,
                opsPickupAt: true,
                assignedBrokerId: true,
            },
        });

        // Read-only rate hints from docs — no sequential UPDATEs on list (was slow).
        // Always load current RC so a newer Flat Rate overlays a stale books carrierRate.
        const needDoc = rows.filter((r) => r.customerRate == null || r.customerRate === 0);
        const docByLead = new Map<string, { inv?: string | null; rc?: string | null }>();
        const leadIds = rows.map((r) => r.shipmentLeadId);
        if (leadIds.length) {
            const docs = await prisma.loadDocument.findMany({
                where: {
                    shipmentLeadId: { in: leadIds },
                    isCurrent: true,
                    docType: {
                        in: needDoc.length
                            ? ["CUSTOMER_INVOICE", "RATE_CONFIRMATION"]
                            : ["RATE_CONFIRMATION"],
                    },
                },
                select: { shipmentLeadId: true, docType: true, contentJson: true },
            });
            for (const d of docs) {
                const slot = docByLead.get(d.shipmentLeadId) || {};
                if (d.docType === "CUSTOMER_INVOICE") slot.inv = d.contentJson;
                if (d.docType === "RATE_CONFIRMATION") slot.rc = d.contentJson;
                docByLead.set(d.shipmentLeadId, slot);
            }
        }

        const brokerIds = [
            ...new Set(rows.map((r) => r.assignedBrokerId).filter(Boolean) as string[]),
        ];
        const brokers = brokerIds.length
            ? await prisma.user.findMany({
                  where: { userId: { in: brokerIds } },
                  select: { userId: true, firstName: true, lastName: true },
              })
            : [];
        const brokerName = new Map(
            brokers.map((b) => [
                b.userId,
                `${b.firstName || ""} ${b.lastName || ""}`.trim() || "—",
            ])
        );

        return rows.map((r) => {
            let customerRate = r.customerRate;
            let carrierRate = r.carrierRate;
            const slot = docByLead.get(r.shipmentLeadId);
            if (slot) {
                if ((customerRate == null || customerRate === 0) && slot.inv) {
                    try {
                        const amt = customerAmountFromInvoiceContent(JSON.parse(slot.inv));
                        if (amt != null && amt > 0) customerRate = amt;
                    } catch {
                        /* ignore */
                    }
                }
                if (slot.rc) {
                    try {
                        const amt = preferRateConCarrierAmount(
                            carrierRate,
                            JSON.parse(slot.rc) as Record<string, unknown>
                        );
                        if (amt != null) carrierRate = amt;
                    } catch {
                        /* ignore */
                    }
                }
            }
            return {
                shipmentLeadId: r.shipmentLeadId,
                loadNumber: r.loadNumber,
                shipmentNumber: r.greenOsShipmentId,
                brokerName: r.assignedBrokerId
                    ? brokerName.get(r.assignedBrokerId) || "—"
                    : "—",
                status: r.status,
                statusLabel: statusLabel(r.status),
                customerName: r.customerName,
                carrierName: r.carrierName,
                pickup: [r.pickupCity, r.pickupState].filter(Boolean).join(", "),
                delivery: [r.deliveryCity, r.deliveryState].filter(Boolean).join(", "),
                pickupCity: r.pickupCity,
                pickupState: r.pickupState,
                deliveryCity: r.deliveryCity,
                deliveryState: r.deliveryState,
                pricing: computePricing({ ...r, customerRate, carrierRate }),
                carrierMissingOnPickup: carrierMissingOnPickup({
                    loadNumber: r.loadNumber,
                    carrierName: r.carrierName,
                    status: r.status,
                    pickupFrom: r.pickupFrom,
                    opsPickupAt: r.opsPickupAt,
                    timeZone: config.timezone,
                }),
                updatedAt: r.updatedAt,
                createdAt: r.createdAt,
            };
        });
    }

    async getLoadDetails(
        shipmentLeadId: string,
        opts?: { includeGps?: boolean; syncLifecycle?: boolean; actorRole?: string }
    ) {
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw Object.assign(new Error("Load not found"), { status: 404 });

        const [brokerUser, documents, mailbox, carrierProfile] = await Promise.all([
            s.assignedBrokerId
                ? prisma.user.findUnique({
                      where: { userId: s.assignedBrokerId },
                      select: { userId: true, firstName: true, lastName: true, email: true },
                  })
                : Promise.resolve(null),
            loadDocumentsService.listCurrent(shipmentLeadId),
            prisma.brokerMailboxMessage.findMany({
                where: { shipmentLeadId },
                orderBy: { receivedAt: "desc" },
                take: 40,
                select: {
                    messageId: true,
                    subject: true,
                    fromAddress: true,
                    snippet: true,
                    receivedAt: true,
                },
            }),
            s.carrierProfileId
                ? prisma.carrier.findUnique({
                      where: { carrierId: s.carrierProfileId },
                      select: {
                          carrierId: true,
                          legalName: true,
                          onboardingStatus: true,
                          status: true,
                          assignedBrokerId: true,
                          mcNumber: true,
                          dotNumber: true,
                          paymentOption: true,
                          phone: true,
                          email: true,
                          documents: {
                              where: {
                                  status: "CURRENT",
                                  documentType: { notIn: ["RATE_CONFIRMATION", "BOL", "POD"] },
                              },
                              orderBy: [{ documentType: "asc" }, { version: "desc" }],
                              select: {
                                  documentId: true,
                                  documentType: true,
                                  originalFilename: true,
                                  mimeType: true,
                                  version: true,
                                  status: true,
                                  uploadedAt: true,
                                  uploadedBy: true,
                              },
                          },
                          agreementSigns: {
                              orderBy: { signedAt: "desc" },
                              take: 1,
                              select: {
                                  signatureId: true,
                                  signerName: true,
                                  signerEmail: true,
                                  signedAt: true,
                                  agreed: true,
                              },
                          },
                      },
                  })
                : Promise.resolve(null),
        ]);

        let broker: { userId: string; name: string; email: string | null; gmail: string | null } | null =
            null;
        if (brokerUser && s.assignedBrokerId) {
            const gmail = await prisma.brokerGmailAccount.findUnique({
                where: { userId: s.assignedBrokerId },
                select: { gmailAddress: true, isActive: true },
            });
            broker = {
                userId: brokerUser.userId,
                name: [brokerUser.firstName, brokerUser.lastName].filter(Boolean).join(" ").trim(),
                email: brokerUser.email,
                gmail:
                    (gmail?.isActive !== false && gmail?.gmailAddress) || brokerUser.email || null,
            };
        }

        // Backfill / heal books from invoice + current Rate Con.
        // Last RC Flat Rate always wins over a stale non-zero carrierRate.
        {
            const patch: { customerRate?: number; carrierRate?: number } = {};
            for (const d of documents as Array<{ docType: string; contentJson?: string | null }>) {
                if (!d.contentJson) continue;
                try {
                    const content = JSON.parse(d.contentJson);
                    if (
                        (s.customerRate == null || s.customerRate === 0) &&
                        d.docType === "CUSTOMER_INVOICE" &&
                        !patch.customerRate
                    ) {
                        const amt = customerAmountFromInvoiceContent(content);
                        if (amt != null && amt > 0) patch.customerRate = amt;
                    }
                    if (d.docType === "RATE_CONFIRMATION" && !patch.carrierRate) {
                        const amt = carrierAmountFromRateConContent(content);
                        if (
                            amt != null &&
                            amt > 0 &&
                            (s.carrierRate == null || Number(s.carrierRate) !== amt)
                        ) {
                            patch.carrierRate = amt;
                        }
                    }
                } catch {
                    /* ignore */
                }
            }
            if (Object.keys(patch).length) {
                await prisma.shipmentLead
                    .update({ where: { shipmentLeadId }, data: patch })
                    .catch((err) => {
                        console.error(
                            `[rc-sync] getLoadDetails heal failed for ${shipmentLeadId}:`,
                            err instanceof Error ? err.message : err
                        );
                        return null;
                    });
                Object.assign(s, patch);
            }
        }

        const packetDocs = (carrierProfile?.documents || []).map((d) => ({
            documentId: d.documentId,
            documentType: d.documentType,
            originalFilename: d.originalFilename,
            uploadedAt: d.uploadedAt,
        }));
        const reviewSlots =
            s.carrierProfileId || s.carrierMc
                ? await buildLoadCarrierReviewPacket({
                      currentShipmentLeadId: shipmentLeadId,
                      carrierProfileId: s.carrierProfileId,
                      carrierMc: s.carrierMc,
                      packetDocs,
                      botActorUserId:
                          s.assignedBrokerId ||
                          carrierProfile?.assignedBrokerId ||
                          null,
                  })
                : [];
        const loadCarrierApproved = isLoadCarrierApproved(s);

        // Lifecycle catch-up is optional — do not block the Load Details paint path.
        if (opts?.syncLifecycle !== false) {
            void (async () => {
                try {
                    const { shipmentService } = await import("./shipment.service.js");
                    const hasDoc = (t: string) => documents.some((d) => d.docType === t);
                    const tryAdvance = async (status: string) => {
                        try {
                            await shipmentService.transitionStatus({
                                shipmentLeadId,
                                status,
                                skipLifecycleCheck: false,
                            });
                            return true;
                        } catch {
                            return false;
                        }
                    };
                    let st = normalizeStatus(s.status);
                    if (hasDoc("POD") && ["IN_TRANSIT", "DELIVERED"].includes(st)) {
                        if (await tryAdvance("POD_UPLOADED")) st = "POD_UPLOADED";
                    }
                    if (
                        hasDoc("CUSTOMER_INVOICE") &&
                        ["IN_TRANSIT", "DELIVERED", "POD_UPLOADED"].includes(st)
                    ) {
                        if (hasDoc("POD") && st === "DELIVERED") {
                            if (await tryAdvance("POD_UPLOADED")) st = "POD_UPLOADED";
                        }
                        await tryAdvance("CUSTOMER_INVOICE");
                    }
                } catch {
                    /* non-blocking */
                }
            })();
        }

        let gps = null;
        if (opts?.includeGps) {
            try {
                const { trackingService } = await import("../../tracking/services/tracking.service.js");
                gps = await trackingService.buildTrackingPayload(shipmentLeadId);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[LOAD_GPS] getLoadDetails includeGps failed ${shipmentLeadId}:`, msg);
                gps = {
                    providerReady: null,
                    configured: false,
                    error: msg,
                    active: null,
                    sessions: [],
                    recentPositions: [],
                };
            }
        }

        const pricing = {
            ...computePricing(s),
            customerPayment: customerPaymentQuote({
                customerRate: s.customerRate,
                accessorialCharges: s.accessorialCharges,
                method: s.customerPaymentMethod,
                waiveFee: s.waiveCustomerPaymentFee,
            }),
        };
        const tracking = trackingFromStatus(s.status, s.trackingStatus);
        const mappedDocs = documents
            .filter((d) => {
                const t = String(d.docType || "").toUpperCase();
                // Load UI only shows Rate Con / BOL / POD (+ payment proofs for Accounting).
                return t !== "DISPATCH_SHEET" && t !== "LOAD_SUMMARY";
            })
            .map((d) => {
            let content: Record<string, unknown> | null = null;
            if (d.contentJson) {
                try {
                    content = JSON.parse(d.contentJson) as Record<string, unknown>;
                } catch {
                    content = null;
                }
            }
            const changeReason = d.changeReason || null;
            const carrierSigned = Boolean(
                content &&
                    (content.carrierSignatureDataUrl || content.carrierSignerName || content.carrierSignedAt)
            );
            return {
                documentId: d.documentId,
                docType: d.docType,
                version: d.version,
                title: d.title,
                status: d.status,
                changeReason,
                changeReasonLabel:
                    (changeReason && LOAD_DOC_CHANGE_LABELS[changeReason]) || changeReason,
                carrierSigned,
                carrierSignerName: content?.carrierSignerName || null,
                carrierSignedAt: content?.carrierSignedAt || null,
                fileUrl: d.fileUrl
                    ? `/api/loads/${shipmentLeadId}/documents/${d.documentId}/download`
                    : null,
                fileName: d.fileName,
                createdAt: d.createdAt,
                content,
            };
        });

        return {
            identity: {
                shipmentLeadId: s.shipmentLeadId,
                loadNumber: s.loadNumber,
                shipmentNumber: s.greenOsShipmentId,
                externalShipmentId: s.externalShipmentId,
                isLoad: Boolean(s.loadNumber) || isLoadPhase(s.status),
                status: s.status,
                statusLabel: statusLabel(s.status),
                isVoided: normalizeStatus(s.status) === "VOIDED",
                accountingReactivatedAt: s.accountingReactivatedAt || null,
                isReactivated: Boolean(s.accountingReactivatedAt),
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                viewUrl: s.viewUrl,
            },
            general: {
                loadNumber: s.loadNumber,
                shipmentNumber: s.greenOsShipmentId,
                customer: s.customerName,
                customerEmail: s.customerEmail,
                customerPhone: s.customerPhone,
                broker,
                brokerGmail: broker?.gmail || null,
                status: s.status,
                statusLabel: statusLabel(s.status),
                pickup: {
                    city: s.pickupCity,
                    state: s.pickupState,
                    zip: s.pickupZip,
                    from: s.pickupFrom,
                    to: s.pickupTo,
                    opsAt: s.opsPickupAt,
                },
                delivery: {
                    city: s.deliveryCity,
                    state: s.deliveryState,
                    zip: s.deliveryZip,
                    from: s.deliveryFrom,
                    to: s.deliveryTo,
                    opsAt: s.opsDeliveryAt,
                },
                equipment: s.equipment,
                commodity: s.commodity || s.vehicle || s.category,
                weight: s.weight,
                pieces: s.pieces,
                miles: s.miles,
                specialInstructions: s.specialInstructions,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
            },
            contacts: {
                brokerGmail: broker?.gmail || null,
                brokerEmail: broker?.email || null,
                customerEmail: s.customerEmail,
                customerPhone: s.customerPhone,
                carrierEmail: s.carrierEmail,
            },
            carrier: {
                carrierName: s.carrierName,
                carrierEmail: s.carrierEmail || carrierProfile?.email || null,
                carrierPhone: s.carrierPhone || carrierProfile?.phone || null,
                mc: s.carrierMc || carrierProfile?.mcNumber || null,
                // Prefer load snapshot, fall back to onboarding packet DOT#.
                dot: s.carrierDot || carrierProfile?.dotNumber || null,
                insurance: s.carrierInsurance,
                carrierStatus: s.carrierStatus,
                driverName: s.driverName,
                driverPhone: s.driverPhone,
                truckNumber: s.truckNumber,
                trailerNumber: s.trailerNumber,
                trailerVin: s.trailerVin,
                // From carrier online packet (mandatory payment radios).
                paymentOption: carrierProfile?.paymentOption || null,
                paymentOptionLabel: carrierPaymentOptionLabel(carrierProfile?.paymentOption) || null,
                carrierProfileId: s.carrierProfileId || carrierProfile?.carrierId || null,
                onboardingStatus: carrierProfile?.onboardingStatus || null,
                loadCarrierApproved: isLoadCarrierApproved(s),
                loadCarrierApprovedAt: s.loadCarrierApprovedAt,
                previousCarriers: parseCarrierHistory(s.carrierHistoryJson),
                carrierRecordStatus: carrierProfile?.status || null,
                agreementSigned: Boolean(carrierProfile?.agreementSigns?.[0]?.agreed),
                agreementSignature: carrierProfile?.agreementSigns?.[0] || null,
                onboardingDocuments: (carrierProfile?.documents || []).map((d) => ({
                    documentId: d.documentId,
                    documentType: d.documentType,
                    originalFilename: d.originalFilename,
                    mimeType: d.mimeType,
                    version: d.version,
                    status: d.status,
                    uploadedAt: d.uploadedAt,
                    uploadedBy: d.uploadedBy,
                    downloadUrl: `/api/carriers/${
                        s.carrierProfileId || carrierProfile?.carrierId
                    }/documents/${d.documentId}/download`,
                })),
                reviewSlots: reviewSlots.map((slot) => ({
                    ...slot,
                    downloadUrl: slot.document
                        ? `/api/carriers/${
                              s.carrierProfileId || carrierProfile?.carrierId
                          }/documents/${slot.document.documentId}/download`
                        : null,
                })),
                futureIntegrations: [
                    "Highway",
                    "Carrier411",
                    "RMIS",
                    "CarrierWatch",
                    "MyCarrierPackets",
                ],
            },
            pricing,
            tracking,
            gps,
            documents: mappedDocs,
            notes: {
                internal: s.notes,
                customer: s.customerNotes,
                carrier: s.carrierNotes,
                ai: s.aiNotes,
                pinned: (() => {
                    try {
                        return s.pinnedNotesJson ? JSON.parse(s.pinnedNotesJson) : [];
                    } catch {
                        return [];
                    }
                })(),
            },
            accounting: {
                customerInvoice: s.invoiceNumber,
                carrierInvoice: documents.find((d) => d.docType === "CARRIER_INVOICE")?.title || null,
                paymentStatus: s.paymentStatus,
                customerPaidAt: s.customerPaidAt,
                customerPaidById: s.customerPaidById,
                carrierPaidAt: s.carrierPaidAt,
                carrierPaidById: s.carrierPaidById,
                customerRate: pricing.customerRate,
                carrierRate: pricing.carrierRate,
                factoring: s.factoringFee,
                brokerProfit: pricing.brokerProfit,
                companyProfit: pricing.companyProfit,
                margin: pricing.marginPct,
                invoiceDate: s.invoiceDate,
                dueDate: s.invoiceDueDate,
                paymentDate: s.paymentDate,
                outstandingBalance:
                    s.customerPaidAt || (s.paymentStatus && /paid/i.test(s.paymentStatus))
                        ? 0
                        : pricing.totalRevenue,
                customerPaidDoc:
                    mappedDocs.find((d) => d.docType === "CUSTOMER_PAID_PROOF") || null,
                carrierPaidDoc:
                    mappedDocs.find((d) => d.docType === "CARRIER_PAID_PROOF") || null,
            },
            reviews: {
                customerSentAt: s.reviewCustomerSentAt,
                customerSentTo: s.reviewCustomerSentTo,
                carrierSentAt: s.reviewCarrierSentAt,
                carrierSentTo: s.reviewCarrierSentTo,
            },
            communications: {
                emails: mailbox,
                sms: [],
                calls: [],
                futureIntegrations: ["RingCentral", "Gmail"],
            },
            timeline: [],
            needsCustomerInfo: !isCustomerInfoReady({
                customerName: s.customerName,
                customerEmail: s.customerEmail,
                customerPhone: s.customerPhone,
            }),
            quickActions: buildLoadQuickActions({
                status: s.status,
                carrierName: s.carrierName,
                customerName: s.customerName,
                customerEmail: s.customerEmail,
                customerPhone: s.customerPhone,
                loadCarrierApproved,
                customerPaidAt: s.customerPaidAt,
                carrierPaidAt: s.carrierPaidAt,
                reviewCustomerSentAt: s.reviewCustomerSentAt,
                reviewCarrierSentAt: s.reviewCarrierSentAt,
                documents,
                unrestricted: roleSkipsLoadGates(opts?.actorRole),
            }),
            futureReady: [
                "DAT",
                "Truckstop",
                "Central Dispatch",
                "uShip",
                "Highway",
                "CarrierWatch",
                "RingCentral",
                "Gmail",
                "QuickBooks",
                "Factoring Companies",
                "GPS Tracking",
                "AI Assistant",
            ],
        };
    }

    /**
     * Carrier change (Name + Email both different): keep the same Load Number,
     * archive the previous carrier on this load, and reactivate Accounting review
     * for the new carrier packet.
     */
    private async replaceCarrierOnSameLoad(
        previous: {
            shipmentLeadId: string;
            loadNumber: string | null;
            status: string;
            carrierName: string | null;
            carrierEmail: string | null;
            carrierPhone: string | null;
            carrierMc: string | null;
            carrierDot: string | null;
            carrierProfileId: string | null;
            carrierRate: number | null;
            carrierHistoryJson?: string | null;
        },
        body: Record<string, unknown>,
        actorUserId?: string
    ) {
        const shipmentLeadId = previous.shipmentLeadId;
        const loadNumber = String(previous.loadNumber || "").trim();
        const str = (k: string) =>
            body[k] === undefined ? undefined : body[k] == null ? null : String(body[k]);
        const num = (k: string) => {
            if (body[k] === undefined) return undefined;
            if (body[k] == null || body[k] === "") return null;
            const n = Number(body[k]);
            return Number.isFinite(n) ? n : null;
        };

        const carrierName = str("carrierName") ?? "";
        const carrierEmail = str("carrierEmail") ?? null;
        const wasVoided = normalizeStatus(previous.status) === "VOIDED";
        const historyJson = appendCarrierHistory(previous.carrierHistoryJson, {
            carrierName: previous.carrierName,
            carrierEmail: previous.carrierEmail,
            carrierPhone: previous.carrierPhone,
            carrierMc: previous.carrierMc,
            carrierDot: previous.carrierDot,
            carrierProfileId: previous.carrierProfileId,
            carrierRate: previous.carrierRate,
            reason: wasVoided ? "carrier_change_from_voided" : "carrier_change",
        });

        const data: Record<string, unknown> = {
            carrierName: carrierName || null,
            carrierEmail,
            carrierPhone: str("carrierPhone") ?? null,
            carrierMc: str("carrierMc") ?? null,
            carrierDot: str("carrierDot") ?? null,
            carrierInsurance: str("carrierInsurance") ?? null,
            carrierStatus: str("carrierStatus") || "Assigned",
            driverName: str("driverName") ?? null,
            driverPhone: str("driverPhone") ?? null,
            truckNumber: str("truckNumber") ?? null,
            trailerNumber: str("trailerNumber") ?? null,
            trailerVin: str("trailerVin") ?? null,
            carrierRate: num("carrierRate") !== undefined ? num("carrierRate") : null,
            carrierProfileId: null,
            loadCarrierApprovedAt: null,
            loadCarrierApprovedById: null,
            loadCarrierApprovedProfileId: null,
            carrierHistoryJson: historyJson,
            // Accounting must re-check the new carrier packet on this Load Number.
            accountingDocStatus: AccountingDocStatus.Pending,
            accountingDocVerifiedAt: null,
            accountingDocVerifiedById: null,
            accountingFinancialVerified: false,
            accountingReadyForBilling: false,
            accountingReadyForCarrierPayment: false,
            accountingReactivatedAt: new Date(),
            status: "CARRIER_ASSIGNED",
            statusBeforeVoid: null,
        };

        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data,
        });

        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "CARRIER_CHANGED",
            title: wasVoided
                ? "Load reactivated with new carrier"
                : "Carrier changed on Load Number",
            message: `Load ${loadNumber || "—"}: ${previous.carrierName || "—"} / ${
                previous.carrierEmail || "—"
            } → ${carrierName || "—"} / ${carrierEmail || "—"}. Previous carrier kept on this Load Number. Accounting review reset.`,
            actorUserId,
            payload: {
                reason: wasVoided ? "carrier_change_from_voided" : "carrier_change",
                loadNumber,
                previousCarrierName: previous.carrierName,
                previousCarrierEmail: previous.carrierEmail,
                previousCarrierProfileId: previous.carrierProfileId,
                newCarrierName: carrierName,
                newCarrierEmail: carrierEmail,
                accountingReactivated: true,
            },
            timelineStage: "CARRIER_ASSIGNED",
        });

        const details = await this.getLoadDetails(shipmentLeadId);
        return {
            ...details,
            carrierChange: {
                shipmentLeadId,
                loadNumber,
                previousCarrierName: previous.carrierName,
                previousCarrierEmail: previous.carrierEmail,
                newCarrierName: carrierName,
                newCarrierEmail: carrierEmail,
                accountingReactivated: true,
                reactivatedFromVoided: wasVoided,
            },
        };
    }

    async deleteLoad(shipmentLeadId: string) {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { shipmentLeadId: true, loadNumber: true },
        });
        if (!shipment?.loadNumber) {
            throw Object.assign(new Error("Load not found"), { status: 404 });
        }
        const unlink = async (sql: string) => {
            try {
                await prisma.$executeRawUnsafe(sql, shipmentLeadId);
            } catch {
                /* older databases may not have the table */
            }
        };
        await unlink(`UPDATE carrier_documents SET shipment_lead_id = NULL WHERE shipment_lead_id = ?`);
        await unlink(`UPDATE carrier_rc_signatures SET shipment_lead_id = NULL WHERE shipment_lead_id = ?`);
        await unlink(`UPDATE carrier_onboarding_events SET shipment_lead_id = NULL WHERE shipment_lead_id = ?`);
        await unlink(`DELETE FROM ai_document_jobs WHERE shipment_lead_id = ?`);
        const removed = await shipmentService.purgeShipmentLead(shipmentLeadId);
        if (!removed) throw Object.assign(new Error("Load not found"), { status: 404 });
        return { shipmentLeadId, loadNumber: shipment.loadNumber };
    }

    async updateLoad(
        shipmentLeadId: string,
        body: Record<string, unknown>,
        actorUserId?: string,
        actorRole?: string
    ) {
        const shipment = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!shipment) throw Object.assign(new Error("Load not found"), { status: 404 });

        // Never allow brokers to invent a load number via patch.
        if (body.loadNumber != null || body.load_number != null) {
            throw Object.assign(
                new Error("Load Number is system-generated only — brokers cannot set it manually"),
                { status: 422 }
            );
        }

        if (body.customerPaymentMethod !== undefined) {
            const method = normalizeCustomerPaymentMethod(body.customerPaymentMethod);
            if (!method) {
                throw Object.assign(new Error("Payment option is required"), { status: 422 });
            }
            const rateRaw = body.customerRate !== undefined ? body.customerRate : shipment.customerRate;
            const rate = rateRaw == null || rateRaw === "" ? null : Number(rateRaw);
            if (rate == null || !Number.isFinite(rate) || rate < 0) {
                throw Object.assign(new Error("Customer rate is required"), { status: 422 });
            }
        }
        if (body.waiveCustomerPaymentFee !== undefined && !canWaiveCustomerPaymentFee(actorRole)) {
            throw Object.assign(
                new Error("Only Accounting can change whether the 3% is added"),
                { status: 403 }
            );
        }

        const nextName =
            body.carrierName !== undefined
                ? body.carrierName == null
                    ? ""
                    : String(body.carrierName)
                : String(shipment.carrierName || "");
        const nextEmail =
            body.carrierEmail !== undefined
                ? body.carrierEmail == null
                    ? ""
                    : String(body.carrierEmail)
                : String(shipment.carrierEmail || "");

        if (
            shipment.loadNumber &&
            isNameAndEmailCarrierChange(
                { name: shipment.carrierName, email: shipment.carrierEmail },
                { name: nextName, email: nextEmail }
            )
        ) {
            // Same Load Number — archive previous carrier, reactivate Accounting review.
            return this.replaceCarrierOnSameLoad(shipment, body, actorUserId);
        }

        const data: Record<string, unknown> = {};
        const str = (k: string, col?: string) => {
            if (body[k] !== undefined) data[col || k] = body[k] == null ? null : String(body[k]);
        };
        const num = (k: string, col?: string) => {
            if (body[k] === undefined) return;
            if (body[k] == null || body[k] === "") {
                data[col || k] = null;
                return;
            }
            const n = Number(body[k]);
            data[col || k] = Number.isFinite(n) ? n : null;
        };

        str("commodity");
        str("equipment");
        str("weight");
        str("specialInstructions");
        str("notes");
        str("customerNotes");
        str("carrierNotes");
        str("aiNotes");
        str("customerEmail");
        str("customerPhone");
        str("carrierEmail");
        str("carrierPhone");
        str("carrierName");
        str("carrierMc");
        str("carrierDot");
        str("carrierInsurance");
        str("carrierStatus");
        str("driverName");
        str("driverPhone");
        str("truckNumber");
        str("trailerNumber");
        str("trailerVin");
        str("paymentStatus");
        str("invoiceNumber");
        str("trackingStatus");
        str("customerName");
        str("pickupCity");
        str("pickupState");
        str("deliveryCity");
        str("deliveryState");
        if (body.customerPaymentMethod !== undefined) {
            data.customerPaymentMethod = normalizeCustomerPaymentMethod(body.customerPaymentMethod);
        }
        if (body.waiveCustomerPaymentFee !== undefined) {
            data.waiveCustomerPaymentFee =
                body.waiveCustomerPaymentFee === true || body.waiveCustomerPaymentFee === "true";
        }
        if (body.status !== undefined) {
            const nextStatus = String(body.status || "").trim().toUpperCase();
            const allowed = new Set([
                "LOAD_CREATED",
                "CARRIER_ASSIGNED",
                "RATE_CON_GENERATED",
                "CARRIER_ACCEPTED",
                "PICKUP",
                "IN_TRANSIT",
                "DELIVERED",
                "POD_UPLOADED",
                "CUSTOMER_INVOICE",
                "CARRIER_PAYMENT",
                "DISPATCH",
                "COMPLETED",
                "CLOSED",
            ]);
            if (!allowed.has(nextStatus)) {
                throw Object.assign(new Error("That load status cannot be set from Change"), {
                    status: 422,
                });
            }
            data.status = nextStatus;
        }
        num("pieces");
        num("miles");
        num("customerRate");
        num("carrierRate");
        num("fuelSurcharge");
        num("accessorialCharges");
        num("factoringFee");
        num("price");

        const dateField = (key: string) => {
            if (body[key] === undefined) return;
            if (body[key] == null || body[key] === "") {
                data[key] = null;
                return;
            }
            const d = new Date(String(body[key]));
            data[key] = Number.isNaN(d.getTime()) ? null : d;
        };
        dateField("pickupFrom");
        dateField("pickupTo");
        dateField("deliveryFrom");
        dateField("deliveryTo");
        dateField("opsPickupAt");
        dateField("opsDeliveryAt");
        dateField("invoiceDate");
        dateField("invoiceDueDate");
        dateField("paymentDate");

        const identityChanged =
            (body.carrierName !== undefined &&
                String(body.carrierName || "") !== String(shipment.carrierName || "")) ||
            (body.carrierEmail !== undefined &&
                String(body.carrierEmail || "") !== String(shipment.carrierEmail || "")) ||
            (body.carrierMc !== undefined &&
                String(body.carrierMc || "") !== String(shipment.carrierMc || ""));
        const explicitProfileId =
            body.carrierProfileId !== undefined
                ? body.carrierProfileId
                    ? String(body.carrierProfileId)
                    : null
                : undefined;
        if (explicitProfileId !== undefined) {
            data.carrierProfileId = explicitProfileId;
        }
        if (identityChanged) {
            data.loadCarrierApprovedAt = null;
            data.loadCarrierApprovedById = null;
            data.loadCarrierApprovedProfileId = null;
            // Force inviteAgreementFromLoad to create/link a new profile instead of
            // renaming the previous carrier (which would mix documents across carriers).
            // Keep an explicitly chosen autofill profile when the broker picked one.
            if (explicitProfileId === undefined) {
                data.carrierProfileId = null;
            }
        }

        if (Object.keys(data).length) {
            await prisma.shipmentLead.update({ where: { shipmentLeadId }, data });
            await domainEventEngine.emit({
                shipmentLeadId,
                eventType: "STATUS_CHANGED",
                title: "Load updated",
                message: "Load details saved",
                actorUserId,
                payload: { fields: Object.keys(data) },
                timelineStage: "LOAD_CREATED",
            });
        }

        if (body.status) {
            const next = normalizeStatus(String(body.status));
            const cur = normalizeStatus(shipment.status);
            if (next !== cur) {
                try {
                    await shipmentService.transitionStatus({
                        shipmentLeadId,
                        status: next,
                        actorUserId,
                    });
                } catch (err) {
                    const code = (err as { status?: number }).status;
                    // Keep saved details when the broker edits a completed step
                    // without rolling the load status backward.
                    if (code !== 422) throw err;
                }
            }
        }

        // Assign carrier shortcut
        if (body.carrierName && !body.status) {
            const st = normalizeStatus(shipment.status);
            if (["LOAD_CREATED", "DISPATCH"].includes(st)) {
                try {
                    await shipmentService.transitionStatus({
                        shipmentLeadId,
                        status: "CARRIER_ASSIGNED",
                        actorUserId,
                    });
                    await domainEventEngine.emit({
                        shipmentLeadId,
                        eventType: "CARRIER_ASSIGNED",
                        title: "Carrier Assigned",
                        message: `Carrier ${String(body.carrierName)} assigned to Load ${shipment.loadNumber}`,
                        actorUserId,
                        payload: { carrierName: body.carrierName },
                        timelineStage: "CARRIER_ASSIGNED",
                    });
                } catch {
                    /* ignore if transition not allowed */
                }
            }
        }

        return this.getLoadDetails(shipmentLeadId);
    }

    /** Carrier did not pick up. Keep the load number and move the load to Voided. */
    async voidLoad(shipmentLeadId: string, actorUserId?: string) {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { status: true, loadNumber: true },
        });
        if (!shipment) throw Object.assign(new Error("Load not found"), { status: 404 });
        const loadNumber = String(shipment.loadNumber || "").trim();
        if (!loadNumber) {
            throw Object.assign(new Error("Generate a load number before voiding"), { status: 422 });
        }
        const status = normalizeStatus(shipment.status);
        if (status === "VOIDED") {
            throw Object.assign(new Error("This load number is already voided"), { status: 422 });
        }
        const pastPickup = [
            "PICKUP",
            "IN_TRANSIT",
            "DELIVERED",
            "POD_UPLOADED",
            "CUSTOMER_INVOICE",
            "CARRIER_PAYMENT",
            "COMPLETED",
            "CLOSED",
        ];
        if (pastPickup.includes(status)) {
            throw Object.assign(
                new Error("This load already moved past pickup and cannot be voided"),
                { status: 422 }
            );
        }
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { status: "VOIDED", statusBeforeVoid: status },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Load voided",
            message: `Load ${loadNumber} voided — carrier did not pick up`,
            actorUserId: actorUserId || undefined,
            timelineStage: "STATUS_CHANGED",
            payload: {
                loadNumber,
                reason: "CARRIER_DID_NOT_PICK_UP",
                from: status,
                to: "VOIDED",
            },
        });
        return this.getLoadDetails(shipmentLeadId);
    }

    /** Broker sets a voided Load Number back to Active (restores prior status). */
    async unvoidLoad(shipmentLeadId: string, actorUserId?: string) {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: {
                status: true,
                loadNumber: true,
                statusBeforeVoid: true,
                carrierName: true,
            },
        });
        if (!shipment) throw Object.assign(new Error("Load not found"), { status: 404 });
        const loadNumber = String(shipment.loadNumber || "").trim();
        if (!loadNumber) {
            throw Object.assign(new Error("Generate a load number before reactivating"), {
                status: 422,
            });
        }
        const status = normalizeStatus(shipment.status);
        if (status !== "VOIDED") {
            throw Object.assign(new Error("This load number is not voided"), { status: 422 });
        }
        const restoreTo = statusAfterUnvoid(shipment.statusBeforeVoid);
        const nextStatus =
            !shipment.carrierName && restoreTo === "CARRIER_ASSIGNED"
                ? "LOAD_CREATED"
                : restoreTo;
        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: {
                status: nextStatus,
                statusBeforeVoid: null,
                accountingReactivatedAt: new Date(),
                accountingDocStatus: AccountingDocStatus.Pending,
                accountingDocVerifiedAt: null,
                accountingDocVerifiedById: null,
                accountingFinancialVerified: false,
                accountingReadyForBilling: false,
                accountingReadyForCarrierPayment: false,
            },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Load reactivated",
            message: `Load ${loadNumber} set Active again (${nextStatus}). Accounting review reset.`,
            actorUserId: actorUserId || undefined,
            timelineStage: "STATUS_CHANGED",
            payload: {
                loadNumber,
                reason: "UNVOID_SET_ACTIVE",
                from: "VOIDED",
                to: nextStatus,
                accountingReactivated: true,
            },
        });
        return this.getLoadDetails(shipmentLeadId);
    }

    async runAction(
        shipmentLeadId: string,
        action: string,
        actorUserId?: string,
        body?: Record<string, unknown>,
        actorRole?: string,
        actorAccountingSubRole?: string | null
    ) {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: {
                status: true,
                carrierName: true,
                carrierProfileId: true,
                carrierMc: true,
                carrierDot: true,
                carrierPhone: true,
                customerName: true,
                customerEmail: true,
                customerPhone: true,
                carrierEmail: true,
                customerPaidAt: true,
                carrierPaidAt: true,
                reviewCustomerSentAt: true,
                reviewCustomerSentTo: true,
                reviewCarrierSentAt: true,
                reviewCarrierSentTo: true,
                loadNumber: true,
                assignedBrokerId: true,
                loadCarrierApprovedAt: true,
                loadCarrierApprovedProfileId: true,
                accountingDocStatus: true,
                accountingFinancialVerified: true,
                accountingReadyForCarrierPayment: true,
                accountingReadyForBilling: true,
            },
        });
        if (!shipment) throw Object.assign(new Error("Load not found"), { status: 404 });
        const documents = await prisma.loadDocument.findMany({
            where: { shipmentLeadId, isCurrent: true, status: { not: "ARCHIVED" } },
            select: { docType: true, contentJson: true },
        });
        const loadCarrierApproved = isLoadCarrierApproved(shipment);
        // Customer contact must be included — otherwise approve_carrier / generate_rate_con
        // look "locked" even after Generate customer information is done on the load.
        assertQuickActionAllowed(action, {
            status: shipment.status,
            carrierName: shipment.carrierName,
            customerName: shipment.customerName,
            customerEmail: shipment.customerEmail,
            customerPhone: shipment.customerPhone,
            loadCarrierApproved,
            customerPaidAt: shipment.customerPaidAt,
            carrierPaidAt: shipment.carrierPaidAt,
            reviewCustomerSentAt: shipment.reviewCustomerSentAt,
            reviewCarrierSentAt: shipment.reviewCarrierSentAt,
            documents,
            unrestricted: roleSkipsLoadGates(actorRole),
        });

        if (action === "close_load") {
            const lifecycleActorId = actorUserId || shipment.assignedBrokerId;
            if (!lifecycleActorId) {
                throw Object.assign(new Error("Closeout review requires an assigned broker"), {
                    status: 422,
                    code: "CLOSEOUT_ACTOR_REQUIRED",
                });
            }
            const lifecycle = await shipmentLifecycleService.build(
                { userId: lifecycleActorId, role: actorRole || "Broker" },
                shipmentLeadId
            );
            if (
                lifecycle.closeoutReadiness === "NOT_READY" ||
                lifecycle.closeoutReadiness === "INCOMPLETE" ||
                lifecycle.blockers.some((blocker) => blocker.critical)
            ) {
                const missing = lifecycle.closeoutChecklist
                    .filter((item) => item.required && !item.ok)
                    .map((item) => item.label);
                throw Object.assign(
                    new Error(
                        `Load cannot be closed yet. Complete: ${missing.join(", ") || "critical lifecycle blockers"}.`
                    ),
                    { status: 422, code: "CLOSEOUT_NOT_READY" }
                );
            }
            if (
                lifecycle.closeoutReadiness === "REVIEW_REQUIRED" &&
                body?.acknowledgeCloseoutWarnings !== true
            ) {
                throw Object.assign(
                    new Error(
                        "Closeout has warnings. Review them and explicitly acknowledge before closing."
                    ),
                    { status: 422, code: "CLOSEOUT_ACK_REQUIRED" }
                );
            }
        }

        if (action === "approve_carrier") {
            if (!String(shipment.carrierName || "").trim()) {
                throw Object.assign(new Error("Assign a carrier before Approve Carrier"), {
                    status: 422,
                });
            }
            let profileId = shipment.carrierProfileId;
            if (!profileId) {
                throw Object.assign(
                    new Error("Save the carrier on this load first, then review documents and click Approve Carrier"),
                    { status: 422, code: "CARRIER_PROFILE_REQUIRED" }
                );
            }
            const profileFull = await prisma.carrier.findUnique({
                where: { carrierId: profileId },
                select: {
                    onboardingStatus: true,
                    assignedBrokerId: true,
                    dotNumber: true,
                    mcNumber: true,
                    phone: true,
                    email: true,
                },
            });
            const onboarding = String(profileFull?.onboardingStatus || "").toUpperCase();
            const reviewSlots = await buildLoadCarrierReviewPacket({
                currentShipmentLeadId: shipmentLeadId,
                carrierProfileId: profileId,
                carrierMc: shipment.carrierMc || profileFull?.mcNumber || null,
                botActorUserId:
                    shipment.assignedBrokerId || profileFull?.assignedBrokerId || actorUserId || null,
                packetDocs: (
                    await prisma.carrierDocument.findMany({
                        where: { carrierId: profileId, status: "CURRENT" },
                        orderBy: [{ documentType: "asc" }, { version: "desc" }],
                        select: {
                            documentId: true,
                            documentType: true,
                            originalFilename: true,
                            uploadedAt: true,
                        },
                    })
                ).map((d) => ({
                    documentId: d.documentId,
                    documentType: d.documentType,
                    originalFilename: d.originalFilename,
                    uploadedAt: d.uploadedAt,
                })),
            });
            const hasReviewMaterial = reviewSlots.some((slot) => slot.present);
            if (!hasReviewMaterial && onboarding !== "APPROVED") {
                throw Object.assign(
                    new Error(
                        "No carrier packet documents found yet. Wait for MC Authority / W-9 / Certificate of Holder / Agreement, then click Approve Carrier."
                    ),
                    { status: 422, code: "CARRIER_REVIEW_DOCS_REQUIRED" }
                );
            }
            if (["SUBMITTED", "UNDER_REVIEW"].includes(onboarding)) {
                await prisma.carrier.update({
                    where: { carrierId: profileId },
                    data: { onboardingStatus: "APPROVED", status: "ACTIVE" },
                });
            }
            const now = new Date();
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: {
                    loadCarrierApprovedAt: now,
                    loadCarrierApprovedById: actorUserId || null,
                    loadCarrierApprovedProfileId: profileId,
                    carrierStatus: "Approved",
                    // Pull mandatory online-packet fields onto the load for Rate Con.
                    carrierDot: shipment.carrierDot || profileFull?.dotNumber || null,
                    carrierMc: shipment.carrierMc || profileFull?.mcNumber || null,
                    carrierPhone: shipment.carrierPhone || profileFull?.phone || null,
                    carrierEmail: shipment.carrierEmail || profileFull?.email || null,
                },
            });
            await domainEventEngine.emit({
                shipmentLeadId,
                eventType: "LOAD_CARRIER_APPROVED",
                title: "Approve Carrier",
                message: `Broker approved carrier documents for Load ${shipment.loadNumber || ""}`,
                actorUserId,
                payload: { carrierProfileId: profileId },
                timelineStage: "CARRIER_ASSIGNED",
            });
            return this.getLoadDetails(shipmentLeadId);
        }

        if (action === "mark_customer_paid" || action === "mark_carrier_paid") {
            const paymentRoles: Set<string> = new Set([
                Roles.Accounting,
                Roles.Owner,
                Roles.Manager,
                Roles.Administrator,
            ]);
            if (!paymentRoles.has(String(actorRole || ""))) {
                throw Object.assign(
                    new Error("Only Accounting, Owner, and Manager can confirm customer or carrier payments"),
                    { status: 403, code: "PAYMENT_ROLE_REQUIRED" }
                );
            }

            const {
                AccountingPermissions,
                hasAccountingPermission,
            } = await import("../../../auth/accounting.js");
            const { AccountingService } = await import(
                "../../accounting/services/accounting.service.js"
            );
            const customerPayment = action === "mark_customer_paid";
            const fullOps = new Set<string>([Roles.Owner, Roles.Manager, Roles.Administrator]);
            if (!fullOps.has(String(actorRole || "")) && customerPayment) {
                if (
                    !hasAccountingPermission(
                        actorRole,
                        actorAccountingSubRole,
                        AccountingPermissions.CustomerPaymentsRecord
                    )
                ) {
                    throw Object.assign(
                        new Error(
                            "Accounting Documents cannot record customer payments — Payments role required"
                        ),
                        { status: 403, code: "ACCOUNTING_FORBIDDEN" }
                    );
                }
            } else if (!fullOps.has(String(actorRole || ""))) {
                if (
                    !hasAccountingPermission(
                        actorRole,
                        actorAccountingSubRole,
                        AccountingPermissions.CarrierPaymentsExecute
                    )
                ) {
                    throw Object.assign(
                        new Error(
                            "Accounting Documents cannot execute carrier payments — Payments role required"
                        ),
                        { status: 403, code: "ACCOUNTING_FORBIDDEN" }
                    );
                }
                AccountingService.assertCarrierPaymentAllowed(shipment, String(actorRole || ""));
            }

            const now = new Date();
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: customerPayment
                    ? {
                          customerPaidAt: now,
                          customerPaidById: actorUserId || null,
                          paymentStatus: "CUSTOMER_PAID",
                          paymentDate: now,
                      }
                    : {
                          carrierPaidAt: now,
                          carrierPaidById: actorUserId || null,
                          paymentStatus: "CUSTOMER_AND_CARRIER_PAID",
                      },
            });

            await domainEventEngine.emit({
                shipmentLeadId,
                eventType: customerPayment ? "CUSTOMER_PAYMENT_RECEIVED" : "CARRIER_PAID",
                title: customerPayment ? "Customer Paid" : "Carrier Paid",
                message: customerPayment
                    ? `Accounting marked Payment Received for Load ${shipment.loadNumber || ""}`
                    : `Accounting marked Carrier / Factoring Paid for Load ${shipment.loadNumber || ""}`,
                actorUserId,
                payload: { paidAt: now.toISOString(), actorRole },
            });

            if (shipment.assignedBrokerId) {
                await platformNotificationService.notifyUser({
                    userId: shipment.assignedBrokerId,
                    notificationType: customerPayment
                        ? "CUSTOMER_PAYMENT_RECEIVED"
                        : "CARRIER_PAID",
                    title: customerPayment ? "Customer Paid" : "Carrier Paid",
                    message: customerPayment
                        ? `Payment Received for Load ${shipment.loadNumber || ""}`
                        : `Carrier / factoring payment completed for Load ${shipment.loadNumber || ""}`,
                    shipmentLeadId,
                    meta: { paidAt: now.toISOString() },
                });
            }

            if (!customerPayment) {
                try {
                    await shipmentService.transitionStatus({
                        shipmentLeadId,
                        status: "CARRIER_PAYMENT",
                        actorUserId,
                    });
                } catch {
                    /* payment fields remain source of truth if lifecycle is already ahead */
                }
            }
            return this.getLoadDetails(shipmentLeadId);
        }

        if (action === "send_review_link") {
            const skipReview = Boolean(body?.skipReview || body?.skip || body?.dontSend);
            const now = new Date();
            const brokerUserId = shipment.assignedBrokerId || actorUserId;

            if (skipReview) {
                const keepCustomer =
                    Boolean(shipment.reviewCustomerSentTo) &&
                    shipment.reviewCustomerSentTo !== "SKIPPED" &&
                    looksLikeEmail(String(shipment.reviewCustomerSentTo));
                const keepCarrier =
                    Boolean(shipment.reviewCarrierSentTo) &&
                    shipment.reviewCarrierSentTo !== "SKIPPED" &&
                    looksLikeEmail(String(shipment.reviewCarrierSentTo));
                await prisma.shipmentLead.update({
                    where: { shipmentLeadId },
                    data: {
                        reviewCustomerSentAt: shipment.reviewCustomerSentAt || now,
                        reviewCustomerSentTo: keepCustomer
                            ? shipment.reviewCustomerSentTo
                            : "SKIPPED",
                        reviewCarrierSentAt: shipment.reviewCarrierSentAt || now,
                        reviewCarrierSentTo: keepCarrier ? shipment.reviewCarrierSentTo : "SKIPPED",
                        reviewSentById: actorUserId || brokerUserId || null,
                    },
                });
                await domainEventEngine.emit({
                    shipmentLeadId,
                    eventType: "REVIEW_LINK_SKIPPED",
                    title: "Review Link Skipped",
                    message: `Broker continued without sending a review link for Load ${
                        shipment.loadNumber || ""
                    }`,
                    actorUserId,
                    payload: { skipped: true },
                });
                return {
                    ...(await this.getLoadDetails(shipmentLeadId)),
                    reviewSkipped: true,
                };
            }

            const sendCustomer = Boolean(body?.sendCustomer ?? body?.customer);
            const sendCarrier = Boolean(body?.sendCarrier ?? body?.carrier);
            if (!sendCustomer && !sendCarrier) {
                throw Object.assign(
                    new Error("Choose Send Customer, Send Carrier, both, or Don't send link"),
                    { status: 422 }
                );
            }

            const customerEmail = String(body?.customerEmail || shipment.customerEmail || "")
                .trim()
                .toLowerCase();
            const carrierEmail = String(body?.carrierEmail || shipment.carrierEmail || "")
                .trim()
                .toLowerCase();
            if (sendCustomer && !looksLikeEmail(customerEmail)) {
                throw Object.assign(
                    new Error("Customer email is missing or invalid. Save it on the General tab first."),
                    { status: 422 }
                );
            }
            if (sendCarrier && !looksLikeEmail(carrierEmail)) {
                throw Object.assign(
                    new Error("Carrier email is missing or invalid. Save it on the Carrier tab first."),
                    { status: 422 }
                );
            }

            const sent: Array<{
                kind: "customer" | "carrier";
                to: string;
                from: string;
                via: "system";
            }> = [];
            const errors: string[] = [];
            if (sendCustomer) {
                try {
                    const result = await sendLoadReviewEmail({
                        to: customerEmail,
                        recipientKind: "customer",
                        recipientName: shipment.customerName,
                        loadNumber: shipment.loadNumber,
                    });
                    sent.push({
                        kind: "customer",
                        to: customerEmail,
                        from: result.from,
                        via: result.via,
                    });
                } catch (err) {
                    errors.push(
                        `Customer (${customerEmail}): ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }
            if (sendCarrier) {
                try {
                    const result = await sendLoadReviewEmail({
                        to: carrierEmail,
                        recipientKind: "carrier",
                        recipientName: shipment.carrierName,
                        loadNumber: shipment.loadNumber,
                    });
                    sent.push({
                        kind: "carrier",
                        to: carrierEmail,
                        from: result.from,
                        via: result.via,
                    });
                } catch (err) {
                    errors.push(
                        `Carrier (${carrierEmail}): ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }
            if (!sent.length) {
                throw Object.assign(new Error(errors.join("\n") || "Failed to send review email"), {
                    status: 400,
                });
            }

            const customerSent = sent.find((row) => row.kind === "customer");
            const carrierSent = sent.find((row) => row.kind === "carrier");
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: {
                    ...(customerSent
                        ? {
                              customerEmail: customerSent.to,
                              reviewCustomerSentAt: now,
                              reviewCustomerSentTo: customerSent.to,
                          }
                        : {}),
                    ...(carrierSent
                        ? {
                              carrierEmail: carrierSent.to,
                              reviewCarrierSentAt: now,
                              reviewCarrierSentTo: carrierSent.to,
                          }
                        : {}),
                    reviewSentById: actorUserId || brokerUserId || null,
                },
            });

            await domainEventEngine.emit({
                shipmentLeadId,
                eventType: "REVIEW_LINK_SENT",
                title: "Review Link Sent",
                message: `Thank-you / review email sent to ${sent
                    .map((row) => `${row.kind} (${row.to})`)
                    .join(" and ")} for Load ${shipment.loadNumber || ""}`,
                actorUserId,
                payload: { sent, errors },
            });

            const details = await this.getLoadDetails(shipmentLeadId);
            return {
                ...details,
                reviewSendResult: sent,
                reviewSendWarning: errors.length ? errors.join(" ") : null,
            };
        }

        const map: Record<string, string> = {
            assign_carrier: "CARRIER_ASSIGNED",
            mark_pickup: "PICKUP",
            mark_loaded: "PICKUP",
            mark_transit: "IN_TRANSIT",
            mark_delivered: "DELIVERED",
            carrier_accepted: "CARRIER_ACCEPTED",
            close_load: "CLOSED",
            carrier_paid: "CARRIER_PAYMENT",
        };

        if (map[action]) {
            await shipmentService.transitionStatus({
                shipmentLeadId,
                status: map[action],
                actorUserId,
            });
            // Stop CarrierView GPS when the load is delivered or closed (best-effort).
            if (action === "close_load" || action === "mark_delivered") {
                try {
                    const { trackingService } = await import(
                        "../../tracking/services/tracking.service.js"
                    );
                    await trackingService.disableTracking(shipmentLeadId, actorUserId);
                } catch (err) {
                    console.warn(
                        `[LOAD_GPS] auto-disable after ${action} failed ${shipmentLeadId}:`,
                        err instanceof Error ? err.message : String(err)
                    );
                }
            }
            return this.getLoadDetails(shipmentLeadId);
        }

        const docMap: Record<string, string> = {
            generate_rate_con: "RATE_CONFIRMATION",
            generate_bol: "BOL",
            generate_invoice: "CUSTOMER_INVOICE",
            create_invoice: "CUSTOMER_INVOICE",
            generate_carrier_invoice: "CARRIER_INVOICE",
            carrier_invoice: "CARRIER_INVOICE",
            upload_pod: "POD",
            generate_pod: "POD",
        };

        if (docMap[action]) {
            await loadDocumentsService.generate({
                shipmentLeadId,
                docType: docMap[action],
                actorUserId,
                actorRole,
                acknowledgeComplianceReview:
                    body?.acknowledgeComplianceReview === true,
                contentOverrides: body?.content as Partial<import("./load-pdf.service.js").LoadDocumentContent> | undefined,
            });
            return this.getLoadDetails(shipmentLeadId);
        }

        throw Object.assign(new Error(`Unknown load action: ${action}`), { status: 422 });
    }
}

export const loadService = new LoadService();

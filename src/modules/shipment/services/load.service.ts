import { prisma } from "../../../config/database.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { shipmentService } from "./shipment.service.js";
import { loadDocumentsService } from "./load-documents.service.js";
import { platformNotificationService } from "./platform-notification.service.js";
import { TRACKING_STEPS } from "../load.constants.js";
import { isLoadPhase, normalizeStatus, statusLabel } from "../shipment.lifecycle.js";
import { allocateLoadNumber } from "../load-number.js";
import { Roles } from "../../../auth/roles.js";
import {
    assertQuickActionAllowed,
    buildLoadQuickActions,
} from "../load-quick-actions.js";
import { sendLoadReviewEmail } from "./load-review-email.service.js";

function money(n: number | null | undefined): number {
    return Number.isFinite(n as number) ? Number(n) : 0;
}

function parseMoneyValue(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function looksLikeEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
}

/** Prefer invoice total (what customer pays), not hourly rate. */
export function customerAmountFromInvoiceContent(content: Record<string, unknown> | null | undefined): number | null {
    if (!content) return null;
    return (
        parseMoneyValue(content.totalAmountDue) ??
        parseMoneyValue(content.invoiceLineTotal) ??
        parseMoneyValue(content.invoiceSubtotal) ??
        parseMoneyValue(content.customerRate) ??
        null
    );
}

export function carrierAmountFromRateConContent(content: Record<string, unknown> | null | undefined): number | null {
    if (!content) return null;
    return parseMoneyValue(content.flatRate) ?? parseMoneyValue(content.carrierRate) ?? null;
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
    async createLoad(shipmentLeadId: string, actorUserId?: string) {
        const shipment = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!shipment) throw Object.assign(new Error("Shipment not found"), { status: 404 });
        if (shipment.loadNumber && String(shipment.loadNumber).trim()) {
            return shipmentService.createLoadAfterAccepted({ shipmentLeadId, actorUserId });
        }
        const loadNumber = await allocateLoadNumber();
        return shipmentService.applyLoadNumber({
            shipmentLeadId,
            loadNumber,
            actorUserId,
        });
    }

    async listLoads(filter: {
        phase: "active" | "completed" | "all";
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
                  : { loadNumber: { not: null } };
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
            },
        });

        // Read-only rate hints from docs — no sequential UPDATEs on list (was slow).
        const needDoc = rows.filter((r) => r.customerRate == null || r.carrierRate == null);
        const docByLead = new Map<string, { inv?: string | null; rc?: string | null }>();
        if (needDoc.length) {
            const docs = await prisma.loadDocument.findMany({
                where: {
                    shipmentLeadId: { in: needDoc.map((r) => r.shipmentLeadId) },
                    isCurrent: true,
                    docType: { in: ["CUSTOMER_INVOICE", "RATE_CONFIRMATION"] },
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
                if ((carrierRate == null || carrierRate === 0) && slot.rc) {
                    try {
                        const amt = carrierAmountFromRateConContent(JSON.parse(slot.rc));
                        if (amt != null && amt > 0) carrierRate = amt;
                    } catch {
                        /* ignore */
                    }
                }
            }
            return {
                shipmentLeadId: r.shipmentLeadId,
                loadNumber: r.loadNumber,
                shipmentNumber: r.greenOsShipmentId,
                status: r.status,
                statusLabel: statusLabel(r.status),
                customerName: r.customerName,
                carrierName: r.carrierName,
                pickup: [r.pickupCity, r.pickupState].filter(Boolean).join(", "),
                delivery: [r.deliveryCity, r.deliveryState].filter(Boolean).join(", "),
                pricing: computePricing({ ...r, customerRate, carrierRate }),
                updatedAt: r.updatedAt,
                createdAt: r.createdAt,
            };
        });
    }

    async getLoadDetails(
        shipmentLeadId: string,
        opts?: { includeGps?: boolean; syncLifecycle?: boolean }
    ) {
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw Object.assign(new Error("Load not found"), { status: 404 });

        const [brokerUser, documents, mailbox] = await Promise.all([
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

        // Backfill Customer / Carrier $ from invoice / Rate Con when DB rates are missing.
        if (s.customerRate == null || s.customerRate === 0 || s.carrierRate == null || s.carrierRate === 0) {
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
                    if (
                        (s.carrierRate == null || s.carrierRate === 0) &&
                        d.docType === "RATE_CONFIRMATION" &&
                        !patch.carrierRate
                    ) {
                        const amt = carrierAmountFromRateConContent(content);
                        if (amt != null && amt > 0) patch.carrierRate = amt;
                    }
                } catch {
                    /* ignore */
                }
            }
            if (Object.keys(patch).length) {
                await prisma.shipmentLead
                    .update({ where: { shipmentLeadId }, data: patch })
                    .catch(() => null);
                Object.assign(s, patch);
            }
        }

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
            } catch {
                gps = null;
            }
        }

        const pricing = computePricing(s);
        const tracking = trackingFromStatus(s.status, s.trackingStatus);
        const mappedDocs = documents.map((d) => {
            let content: Record<string, unknown> | null = null;
            if (d.contentJson) {
                try {
                    content = JSON.parse(d.contentJson) as Record<string, unknown>;
                } catch {
                    content = null;
                }
            }
            return {
                documentId: d.documentId,
                docType: d.docType,
                version: d.version,
                title: d.title,
                status: d.status,
                changeReason: d.changeReason,
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
                carrierEmail: s.carrierEmail,
                carrierPhone: s.carrierPhone,
                mc: s.carrierMc,
                dot: s.carrierDot,
                insurance: s.carrierInsurance,
                carrierStatus: s.carrierStatus,
                driverName: s.driverName,
                driverPhone: s.driverPhone,
                truckNumber: s.truckNumber,
                trailerNumber: s.trailerNumber,
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
            quickActions: buildLoadQuickActions({
                status: s.status,
                carrierName: s.carrierName,
                customerPaidAt: s.customerPaidAt,
                carrierPaidAt: s.carrierPaidAt,
                reviewCustomerSentAt: s.reviewCustomerSentAt,
                reviewCarrierSentAt: s.reviewCarrierSentAt,
                documents,
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

    async updateLoad(
        shipmentLeadId: string,
        body: Record<string, unknown>,
        actorUserId?: string
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
        str("paymentStatus");
        str("invoiceNumber");
        str("trackingStatus");
        str("customerName");
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

    async runAction(
        shipmentLeadId: string,
        action: string,
        actorUserId?: string,
        body?: Record<string, unknown>,
        actorRole?: string
    ) {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: {
                status: true,
                carrierName: true,
                customerName: true,
                customerEmail: true,
                carrierEmail: true,
                customerPaidAt: true,
                carrierPaidAt: true,
                reviewCustomerSentAt: true,
                reviewCarrierSentAt: true,
                loadNumber: true,
                assignedBrokerId: true,
            },
        });
        if (!shipment) throw Object.assign(new Error("Load not found"), { status: 404 });
        const documents = await prisma.loadDocument.findMany({
            where: { shipmentLeadId, isCurrent: true, status: { not: "ARCHIVED" } },
            select: { docType: true, contentJson: true },
        });
        assertQuickActionAllowed(action, {
            status: shipment.status,
            carrierName: shipment.carrierName,
            customerPaidAt: shipment.customerPaidAt,
            carrierPaidAt: shipment.carrierPaidAt,
            reviewCustomerSentAt: shipment.reviewCustomerSentAt,
            reviewCarrierSentAt: shipment.reviewCarrierSentAt,
            documents,
        });

        if (action === "mark_customer_paid" || action === "mark_carrier_paid") {
            const paymentRoles: Set<string> = new Set([
                Roles.Accounting,
                Roles.Owner,
                Roles.Administrator,
            ]);
            if (!paymentRoles.has(String(actorRole || ""))) {
                throw Object.assign(
                    new Error("Only Accounting can confirm customer or carrier payments"),
                    { status: 403, code: "PAYMENT_ROLE_REQUIRED" }
                );
            }

            const now = new Date();
            const customerPayment = action === "mark_customer_paid";
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
            const sendCustomer = Boolean(body?.sendCustomer ?? body?.customer);
            const sendCarrier = Boolean(body?.sendCarrier ?? body?.carrier);
            if (!sendCustomer && !sendCarrier) {
                throw Object.assign(
                    new Error("Choose Send Customer, Send Carrier, or both"),
                    { status: 422 }
                );
            }

            const brokerUserId = shipment.assignedBrokerId || actorUserId;

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

            const now = new Date();
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
            return this.getLoadDetails(shipmentLeadId);
        }

        const docMap: Record<string, string> = {
            generate_rate_con: "RATE_CONFIRMATION",
            generate_bol: "BOL",
            generate_invoice: "CUSTOMER_INVOICE",
            create_invoice: "CUSTOMER_INVOICE",
            generate_carrier_invoice: "CARRIER_INVOICE",
            carrier_invoice: "CARRIER_INVOICE",
            generate_dispatch_sheet: "DISPATCH_SHEET",
            generate_load_summary: "LOAD_SUMMARY",
            upload_pod: "POD",
            generate_pod: "POD",
        };

        if (docMap[action]) {
            await loadDocumentsService.generate({
                shipmentLeadId,
                docType: docMap[action],
                actorUserId,
                contentOverrides: body?.content as Partial<import("./load-pdf.service.js").LoadDocumentContent> | undefined,
            });
            return this.getLoadDetails(shipmentLeadId);
        }

        throw Object.assign(new Error(`Unknown load action: ${action}`), { status: 422 });
    }
}

export const loadService = new LoadService();

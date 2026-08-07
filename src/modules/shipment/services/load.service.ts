import { prisma } from "../../../config/database.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { shipmentService } from "./shipment.service.js";
import { loadDocumentsService } from "./load-documents.service.js";
import { TRACKING_STEPS } from "../load.constants.js";
import { isLoadPhase, normalizeStatus, statusLabel } from "../shipment.lifecycle.js";
import { allocateLoadNumber } from "../load-number.js";

function money(n: number | null | undefined): number {
    return Number.isFinite(n as number) ? Number(n) : 0;
}

export function computePricing(row: {
    price?: number | null;
    customerRate?: number | null;
    carrierRate?: number | null;
    fuelSurcharge?: number | null;
    accessorialCharges?: number | null;
    factoringFee?: number | null;
}) {
    const customerRate = money(row.customerRate ?? row.price);
    const carrierRate = money(row.carrierRate);
    const fuel = money(row.fuelSurcharge);
    const accessorials = money(row.accessorialCharges);
    const factoring = money(row.factoringFee);
    const totalRevenue = customerRate + fuel + accessorials;
    const totalCost = carrierRate + factoring;
    const grossProfit = totalRevenue - totalCost;
    const marginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    return {
        customerRate,
        carrierRate,
        fuelSurcharge: fuel,
        accessorialCharges: accessorials,
        factoringFee: factoring,
        totalRevenue,
        totalCost,
        grossProfit,
        profit: grossProfit,
        marginPct: Math.round(marginPct * 100) / 100,
        companyProfit: grossProfit,
        brokerProfit: grossProfit,
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

    async listLoads(filter: { phase: "active" | "completed" | "all"; limit?: number }) {
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

        const where =
            filter.phase === "active"
                ? { loadNumber: { not: null }, status: { in: activeStatuses } }
                : filter.phase === "completed"
                  ? { loadNumber: { not: null }, status: { in: completedStatuses } }
                  : { loadNumber: { not: null } };

        const rows = await prisma.shipmentLead.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: limit,
        });

        return rows.map((r) => ({
            shipmentLeadId: r.shipmentLeadId,
            loadNumber: r.loadNumber,
            shipmentNumber: r.greenOsShipmentId,
            status: r.status,
            statusLabel: statusLabel(r.status),
            customerName: r.customerName,
            carrierName: r.carrierName,
            pickup: [r.pickupCity, r.pickupState].filter(Boolean).join(", "),
            delivery: [r.deliveryCity, r.deliveryState].filter(Boolean).join(", "),
            pricing: computePricing(r),
            updatedAt: r.updatedAt,
            createdAt: r.createdAt,
        }));
    }

    async getLoadDetails(shipmentLeadId: string) {
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw Object.assign(new Error("Load not found"), { status: 404 });

        let broker: { userId: string; name: string; email: string | null; gmail: string | null } | null =
            null;
        if (s.assignedBrokerId) {
            const u = await prisma.user.findUnique({
                where: { userId: s.assignedBrokerId },
                select: { userId: true, firstName: true, lastName: true, email: true },
            });
            if (u) {
                const gmail = await prisma.brokerGmailAccount.findUnique({
                    where: { userId: s.assignedBrokerId },
                    select: { gmailAddress: true, isActive: true },
                });
                broker = {
                    userId: u.userId,
                    name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim(),
                    email: u.email,
                    gmail: (gmail?.isActive !== false && gmail?.gmailAddress) || u.email || null,
                };
            }
        }

        let dispatcher: { userId: string; name: string } | null = null;
        if (s.assignedDispatcherId) {
            const u = await prisma.user.findUnique({
                where: { userId: s.assignedDispatcherId },
                select: { userId: true, firstName: true, lastName: true },
            });
            if (u) {
                dispatcher = {
                    userId: u.userId,
                    name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim(),
                };
            }
        }

        const documents = await loadDocumentsService.listCurrent(shipmentLeadId);
        const timeline = await domainEventEngine.listForShipment(shipmentLeadId);
        const pricing = computePricing(s);
        const tracking = trackingFromStatus(s.status, s.trackingStatus);

        const mailbox = await prisma.brokerMailboxMessage.findMany({
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
        });

        return {
            identity: {
                shipmentLeadId: s.shipmentLeadId,
                loadNumber: s.loadNumber,
                shipmentNumber: s.greenOsShipmentId,
                externalShipmentId: s.externalShipmentId,
                referenceNumber: s.referenceNumber,
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
                broker,
                brokerGmail: broker?.gmail || null,
                dispatcher,
                status: s.status,
                statusLabel: statusLabel(s.status),
                referenceNumber: s.referenceNumber || s.externalShipmentId,
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
                carrierEmail: s.carrierEmail,
            },
            carrier: {
                carrierName: s.carrierName,
                carrierEmail: s.carrierEmail,
                mc: s.carrierMc,
                dot: s.carrierDot,
                insurance: s.carrierInsurance,
                carrierStatus: s.carrierStatus,
                assignedDispatcher: dispatcher,
                driverName: s.driverName,
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
            documents: documents.map((d) => ({
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
            })),
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
                factoring: s.factoringFee,
                brokerProfit: pricing.brokerProfit,
                companyProfit: pricing.companyProfit,
                margin: pricing.marginPct,
                invoiceDate: s.invoiceDate,
                dueDate: s.invoiceDueDate,
                paymentDate: s.paymentDate,
                outstandingBalance:
                    s.paymentStatus && /paid/i.test(s.paymentStatus) ? 0 : pricing.totalRevenue,
            },
            communications: {
                emails: mailbox,
                sms: [],
                calls: [],
                futureIntegrations: ["RingCentral", "Gmail"],
            },
            timeline: timeline.map((e) => ({
                eventId: e.eventId,
                eventType: e.eventType,
                title: e.title,
                message: e.message,
                createdAt: e.createdAt,
                actorUserId: e.actorUserId,
            })),
            quickActions: [
                { id: "assign_carrier", label: "Assign Carrier", status: "CARRIER_ASSIGNED" },
                { id: "generate_rate_con", label: "Generate Rate Confirmation", docType: "RATE_CONFIRMATION" },
                { id: "generate_bol", label: "Generate BOL", docType: "BOL" },
                { id: "mark_pickup", label: "Mark Loaded / Pickup", status: "PICKUP" },
                { id: "mark_transit", label: "Mark In Transit", status: "IN_TRANSIT" },
                { id: "mark_delivered", label: "Mark Delivered", status: "DELIVERED" },
                { id: "upload_pod", label: "Generate POD", docType: "POD" },
                { id: "create_invoice", label: "Create Invoice", docType: "CUSTOMER_INVOICE" },
                { id: "carrier_invoice", label: "Carrier Invoice", docType: "CARRIER_INVOICE" },
                { id: "close_load", label: "Close Load", status: "CLOSED" },
            ],
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

        str("referenceNumber");
        str("commodity");
        str("equipment");
        str("weight");
        str("specialInstructions");
        str("notes");
        str("customerNotes");
        str("carrierNotes");
        str("aiNotes");
        str("customerEmail");
        str("carrierEmail");
        str("carrierName");
        str("carrierMc");
        str("carrierDot");
        str("carrierInsurance");
        str("carrierStatus");
        str("driverName");
        str("truckNumber");
        str("trailerNumber");
        str("paymentStatus");
        str("invoiceNumber");
        str("trackingStatus");
        str("assignedDispatcherId");
        str("customerName");        num("pieces");
        num("miles");
        num("customerRate");
        num("carrierRate");
        num("fuelSurcharge");
        num("accessorialCharges");
        num("factoringFee");
        num("price");

        if (body.opsPickupAt !== undefined) {
            data.opsPickupAt = body.opsPickupAt ? new Date(String(body.opsPickupAt)) : null;
        }
        if (body.opsDeliveryAt !== undefined) {
            data.opsDeliveryAt = body.opsDeliveryAt ? new Date(String(body.opsDeliveryAt)) : null;
        }
        if (body.invoiceDate !== undefined) {
            data.invoiceDate = body.invoiceDate ? new Date(String(body.invoiceDate)) : null;
        }
        if (body.invoiceDueDate !== undefined) {
            data.invoiceDueDate = body.invoiceDueDate ? new Date(String(body.invoiceDueDate)) : null;
        }
        if (body.paymentDate !== undefined) {
            data.paymentDate = body.paymentDate ? new Date(String(body.paymentDate)) : null;
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
            await shipmentService.transitionStatus({
                shipmentLeadId,
                status: String(body.status),
                actorUserId,
            });
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
        body?: Record<string, unknown>
    ) {
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

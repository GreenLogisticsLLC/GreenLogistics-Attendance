import { prisma } from "../../../config/database.js";
import { allocateGreenOsShipmentId, ensureGreenOsShipmentId } from "../shipment.id.js";
import {
    assertTransition,
    isLoadPhase,
    normalizeStatus,
    statusLabel,
} from "../shipment.lifecycle.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { STATUS_LABELS } from "../shipment.constants.js";

/**
 * Shipment Aggregate Root service.
 * Physical table remains `shipment_leads` for compatibility — one permanent card.
 */
export class ShipmentService {
    /**
     * CRITICAL RULE: Load Number extends the existing Shipment Card.
     * Never creates a Load entity or second shipment record.
     */
    async applyLoadNumber(input: {
        shipmentLeadId: string;
        loadNumber: string;
        actorUserId?: string;
        forceStatus?: boolean;
    }) {
        const loadNumber = String(input.loadNumber || "").trim();
        if (!loadNumber) {
            throw Object.assign(new Error("Load Number is required"), { status: 422 });
        }

        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
        });
        if (!shipment) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }

        await ensureGreenOsShipmentId(shipment.shipmentLeadId);

        const previousStatus = shipment.status;
        let nextStatus = normalizeStatus(shipment.status);

        // Move into LOAD_CREATED if not already in/after load phase
        if (!isLoadPhase(nextStatus) || input.forceStatus) {
            // Prefer ACCEPTED → LOAD_CREATED; allow from WORKING/BID/etc. when load appears
            if (!isLoadPhase(nextStatus)) {
                if (
                    ["ACCEPTED", "WORKING", "BID_SUBMITTED", "CUSTOMER_REPLIED", "BOOKED"].includes(
                        normalizeStatus(previousStatus)
                    )
                ) {
                    assertTransition(previousStatus, "LOAD_CREATED");
                    nextStatus = "LOAD_CREATED";
                } else if (normalizeStatus(previousStatus) === "NEW") {
                    // Rare: load without prior accept — still same card
                    nextStatus = "LOAD_CREATED";
                } else {
                    assertTransition(previousStatus, "LOAD_CREATED");
                    nextStatus = "LOAD_CREATED";
                }
            }
        }

        // Same row update only — NO prisma.create for a Load
        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId: shipment.shipmentLeadId },
            data: {
                loadNumber,
                status: nextStatus,
                ...(nextStatus === "LOAD_CREATED" && !shipment.acceptedAt
                    ? { acceptedAt: shipment.acceptedAt || new Date() }
                    : {}),
            },
        });

        await domainEventEngine.emit({
            shipmentLeadId: shipment.shipmentLeadId,
            eventType: "LOAD_CREATED",
            title: "Load Created",
            message: `Load Number ${loadNumber} attached to Shipment ${updated.greenOsShipmentId || shipment.shipmentLeadId}`,
            actorUserId: input.actorUserId,
            payload: {
                loadNumber,
                previousStatus,
                status: nextStatus,
                greenOsShipmentId: updated.greenOsShipmentId,
                // Explicit architecture guard for future modules
                createdNewRecord: false,
                sameShipmentCard: true,
            },
            timelineStage: "LOAD_CREATED",
        });

        return updated;
    }

    async transitionStatus(input: {
        shipmentLeadId: string;
        status: string;
        actorUserId?: string;
        extras?: { notes?: string; price?: number; priority?: string; loadNumber?: string };
        skipLifecycleCheck?: boolean;
    }) {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
        });
        if (!shipment) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }

        const to = normalizeStatus(input.status);
        if (!input.skipLifecycleCheck) {
            assertTransition(shipment.status, to);
        }

        // If caller sets LOAD_CREATED with a load number — use applyLoadNumber path
        if (to === "LOAD_CREATED" && input.extras?.loadNumber) {
            return this.applyLoadNumber({
                shipmentLeadId: input.shipmentLeadId,
                loadNumber: input.extras.loadNumber,
                actorUserId: input.actorUserId,
                forceStatus: true,
            });
        }

        const data: Record<string, unknown> = { status: to };
        if (input.extras?.notes !== undefined) data.notes = input.extras.notes;
        if (input.extras?.price !== undefined) data.price = input.extras.price;
        if (input.extras?.priority !== undefined) data.priority = input.extras.priority;
        if (to === "BID_SUBMITTED") data.quoteSentAt = new Date();
        if (to === "ACCEPTED" && !shipment.acceptedAt) data.acceptedAt = new Date();
        if (to === "COMPLETED" || to === "CLOSED" || to === "LOST") {
            data.closedAt = new Date();
        }

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId: input.shipmentLeadId },
            data,
        });

        await domainEventEngine.emitStatusChange({
            shipmentLeadId: input.shipmentLeadId,
            fromStatus: shipment.status,
            toStatus: to,
            actorUserId: input.actorUserId,
            message: `Status → ${statusLabel(to)}`,
            payload: { extras: input.extras || {} },
        });

        return updated;
    }

    async markImported(shipmentLeadId: string, meta?: Record<string, unknown>) {
        await ensureGreenOsShipmentId(shipmentLeadId);
        const row = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            select: { greenOsShipmentId: true, shipmentTitle: true },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "SHIPMENT_IMPORTED",
            title: "Shipment Imported",
            message: `Imported ${row?.shipmentTitle || shipmentLeadId} (${row?.greenOsShipmentId})`,
            payload: meta,
            timelineStage: "SHIPMENT_IMPORTED",
        });
    }

    /**
     * Sprint G — Operations fields on the SAME Shipment Card (never a new entity).
     */
    async updateOperations(
        shipmentLeadId: string,
        ops: {
            carrierName?: string | null;
            driverName?: string | null;
            truckNumber?: string | null;
            trailerNumber?: string | null;
            rateConfirmation?: string | null;
            podUrl?: string | null;
            invoiceNumber?: string | null;
            paymentStatus?: string | null;
            opsPickupAt?: string | Date | null;
            opsDeliveryAt?: string | Date | null;
            loadNumber?: string | null;
        },
        actorUserId?: string
    ) {
        const shipment = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!shipment) {
            throw Object.assign(new Error("Shipment not found"), { status: 404 });
        }

        if (ops.loadNumber && String(ops.loadNumber).trim()) {
            await this.applyLoadNumber({
                shipmentLeadId,
                loadNumber: String(ops.loadNumber).trim(),
                actorUserId,
            });
        }

        const data: Record<string, unknown> = {};
        if (ops.carrierName !== undefined) data.carrierName = ops.carrierName;
        if (ops.driverName !== undefined) data.driverName = ops.driverName;
        if (ops.truckNumber !== undefined) data.truckNumber = ops.truckNumber;
        if (ops.trailerNumber !== undefined) data.trailerNumber = ops.trailerNumber;
        if (ops.rateConfirmation !== undefined) data.rateConfirmation = ops.rateConfirmation;
        if (ops.podUrl !== undefined) data.podUrl = ops.podUrl;
        if (ops.invoiceNumber !== undefined) data.invoiceNumber = ops.invoiceNumber;
        if (ops.paymentStatus !== undefined) data.paymentStatus = ops.paymentStatus;
        if (ops.opsPickupAt !== undefined) {
            data.opsPickupAt = ops.opsPickupAt ? new Date(ops.opsPickupAt) : null;
        }
        if (ops.opsDeliveryAt !== undefined) {
            data.opsDeliveryAt = ops.opsDeliveryAt ? new Date(ops.opsDeliveryAt) : null;
        }

        const updated = await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data,
        });

        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "STATUS_CHANGED",
            title: "Operations updated",
            message: "Operations fields saved on Shipment Card",
            actorUserId,
            payload: { ...ops, sameShipmentCard: true },
            timelineStage: "DISPATCH_STARTED",
        });

        return updated;
    }
}

export const shipmentService = new ShipmentService();

export { STATUS_LABELS, allocateGreenOsShipmentId, ensureGreenOsShipmentId };

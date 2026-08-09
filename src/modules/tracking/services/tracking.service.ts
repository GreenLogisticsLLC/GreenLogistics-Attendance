import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { getTrackingProvider } from "../registry.js";
import type { NormalizedPosition, NormalizedTrackingLoad, TrackingLocationInput } from "../types.js";
import { fingerprintEvent, fingerprintPosition, formatCvDate } from "../providers/carrier-view/mapper.js";
import { carrierViewUserMessage } from "../providers/carrier-view/errors.js";
import { carrierViewClient } from "../providers/carrier-view/client.js";

function placeAddress(city?: string | null, state?: string | null, zip?: string | null) {
    return [city, state, zip].filter(Boolean).join(", ");
}

function applyLoadSnapshot(normalized: NormalizedTrackingLoad) {
    return {
        driverPhone: normalized.driverPhone,
        trackingUrl: normalized.trackingUrl,
        clientTrackingUrl: normalized.clientTrackingUrl,
        routeStarted: normalized.routeStarted,
        driverIsLate: normalized.driverIsLate,
        timeLeftSec: normalized.timeLeftSec,
        distanceLeftMeters: normalized.distanceLeftMeters,
        driverAppStatus: normalized.driverAppStatus,
        providerLocationsJson: normalized.locations
            ? JSON.stringify(normalized.locations)
            : undefined,
        providerStatusesJson: normalized.statuses ? JSON.stringify(normalized.statuses) : undefined,
        lastSyncedAt: new Date(),
        lastError: null as string | null,
        ...(normalized.lastPosition
            ? {
                  lastLatitude: normalized.lastPosition.latitude,
                  lastLongitude: normalized.lastPosition.longitude,
                  lastAddress: normalized.lastPosition.address,
                  lastPositionAt: normalized.lastPosition.timestamp
                      ? new Date(normalized.lastPosition.timestamp)
                      : new Date(),
                  movementType: normalized.lastPosition.movementType,
              }
            : {}),
    };
}

async function recordEvent(input: {
    provider: string;
    eventType: string;
    providerLoadId?: string | null;
    shipmentLeadId?: string | null;
    trackingId?: string | null;
    payload: unknown;
    status?: string;
    errorMessage?: string | null;
}) {
    const payloadHash = fingerprintEvent({
        eventType: input.eventType,
        providerLoadId: input.providerLoadId || null,
        shipmentLeadId: input.shipmentLeadId || null,
        payload: input.payload,
    });
    try {
        return await prisma.trackingIntegrationEvent.create({
            data: {
                provider: input.provider,
                eventType: input.eventType,
                providerLoadId: input.providerLoadId || null,
                shipmentLeadId: input.shipmentLeadId || null,
                trackingId: input.trackingId || null,
                payloadHash,
                processingStatus: input.status || "PROCESSED",
                errorMessage: input.errorMessage || null,
                rawPayloadJson: JSON.stringify(input.payload).slice(0, 50000),
                processedAt: new Date(),
            },
        });
    } catch (err: unknown) {
        // Unique constraint → duplicate event
        if (String((err as { code?: string })?.code || "").includes("P2002")) {
            return prisma.trackingIntegrationEvent.findFirst({
                where: {
                    provider: input.provider,
                    eventType: input.eventType,
                    payloadHash,
                },
            });
        }
        throw err;
    }
}

async function storePosition(trackingId: string, shipmentLeadId: string, pos: NormalizedPosition) {
    const fp = fingerprintPosition({
        providerLoadId: pos.providerLoadId,
        latitude: pos.latitude,
        longitude: pos.longitude,
        timestamp: pos.timestamp,
        movementType: pos.movementType,
    });
    try {
        await prisma.trackingPosition.create({
            data: {
                trackingId,
                shipmentLeadId,
                provider: pos.provider,
                providerLoadId: pos.providerLoadId,
                driverPhone: pos.driverPhone,
                latitude: pos.latitude,
                longitude: pos.longitude,
                address: pos.address,
                movementType: pos.movementType,
                rotation: pos.rotation,
                lateSeconds: pos.lateSeconds,
                stoppedDuration: pos.stoppedDuration,
                driveDuration: pos.driveDuration,
                pausedDuration: pos.pausedDuration,
                providerTimestamp: pos.timestamp ? new Date(pos.timestamp) : null,
                fingerprint: fp,
            },
        });
    } catch (err: unknown) {
        if (!String((err as { code?: string })?.code || "").includes("P2002")) throw err;
    }

    await prisma.shipmentTracking.update({
        where: { trackingId },
        data: {
            lastLatitude: pos.latitude,
            lastLongitude: pos.longitude,
            lastAddress: pos.address,
            lastPositionAt: pos.timestamp ? new Date(pos.timestamp) : new Date(),
            movementType: pos.movementType,
            driverPhone: pos.driverPhone || undefined,
            driverIsLate: (pos.lateSeconds || 0) > 0 ? true : undefined,
            lastSyncedAt: new Date(),
        },
    });
}

export class TrackingService {
    async getStatusForShipment(shipmentLeadId: string) {
        const rows = await prisma.shipmentTracking.findMany({
            where: { shipmentLeadId },
            orderBy: { updatedAt: "desc" },
        });
        return rows;
    }

    async getActiveTracking(shipmentLeadId: string, provider = "carrier_view") {
        return prisma.shipmentTracking.findFirst({
            where: { shipmentLeadId, provider, status: "ACTIVE" },
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * Idempotent: if ACTIVE CarrierView tracking exists, return it.
     */
    async startCarrierViewTracking(input: {
        shipmentLeadId: string;
        actorUserId?: string;
        driverPhone?: string | null;
        forceRecreate?: boolean;
        startsActiveMinutes?: number;
        emails?: string[];
    }) {
        if (!config.carrierView.enabled) {
            throw Object.assign(new Error("CarrierView integration is disabled"), { status: 503 });
        }
        if (!carrierViewClient.isConfigured()) {
            throw Object.assign(
                new Error("CarrierView is not configured (API base URL / token)"),
                { status: 503 }
            );
        }

        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: input.shipmentLeadId },
        });
        if (!shipment) throw Object.assign(new Error("Shipment not found"), { status: 404 });
        if (!shipment.loadNumber) {
            throw Object.assign(new Error("Create Load first before starting GPS tracking"), {
                status: 422,
            });
        }

        const existing = await this.getActiveTracking(input.shipmentLeadId, "carrier_view");
        if (existing && !input.forceRecreate) {
            return existing;
        }

        const phone = (input.driverPhone || shipment.driverPhone || "").trim();
        if (!phone) {
            throw Object.assign(new Error("Driver phone is required for CarrierView tracking"), {
                status: 422,
            });
        }

        const pickupAddr = placeAddress(shipment.pickupCity, shipment.pickupState, shipment.pickupZip);
        const destAddr = placeAddress(
            shipment.deliveryCity,
            shipment.deliveryState,
            shipment.deliveryZip
        );
        if (!pickupAddr || !destAddr) {
            throw Object.assign(new Error("Pickup and destination addresses are required"), {
                status: 422,
            });
        }

        const locations: TrackingLocationInput[] = [
            {
                address: pickupAddr,
                company: shipment.customerName || "Pickup",
                comment: shipment.specialInstructions || shipment.carrierNotes || "",
                type: "pickup",
                dateFrom: formatCvDate(shipment.opsPickupAt || shipment.pickupFrom),
                dateTo: formatCvDate(shipment.pickupTo || shipment.opsPickupAt || shipment.pickupFrom),
            },
            {
                address: destAddr,
                company: shipment.customerName || "Destination",
                comment: "",
                type: "destination",
                dateFrom: formatCvDate(shipment.opsDeliveryAt || shipment.deliveryFrom),
                dateTo: formatCvDate(
                    shipment.deliveryTo || shipment.opsDeliveryAt || shipment.deliveryFrom
                ),
            },
        ];

        if (input.driverPhone && input.driverPhone !== shipment.driverPhone) {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId: input.shipmentLeadId },
                data: { driverPhone: phone },
            });
        } else if (!shipment.driverPhone) {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId: input.shipmentLeadId },
                data: { driverPhone: phone },
            });
        }

        const provider = getTrackingProvider("carrier_view");
        let normalized;
        try {
            normalized = await provider.createLoad({
                shipmentLeadId: input.shipmentLeadId,
                externalLoadRef: shipment.loadNumber,
                driverPhone: phone,
                locations,
                startsActiveMinutes: input.startsActiveMinutes ?? 60,
                emails: input.emails ?? [],
                dispatchers: [],
            });
        } catch (err) {
            await recordEvent({
                provider: "carrier_view",
                eventType: "load_create_failed",
                shipmentLeadId: input.shipmentLeadId,
                payload: { error: carrierViewUserMessage(err) },
                status: "FAILED",
                errorMessage: carrierViewUserMessage(err),
            });
            throw err;
        }

        if (existing && input.forceRecreate) {
            await prisma.shipmentTracking.update({
                where: { trackingId: existing.trackingId },
                data: { status: "DISABLED", disabledAt: new Date() },
            });
        }

        const row = await prisma.shipmentTracking.create({
            data: {
                shipmentLeadId: input.shipmentLeadId,
                provider: "carrier_view",
                providerLoadId: normalized.providerLoadId,
                externalLoadRef: normalized.externalLoadRef || shipment.loadNumber,
                status: "ACTIVE",
                ...applyLoadSnapshot(normalized),
            },
        });

        if (normalized.lastPosition) {
            await storePosition(row.trackingId, input.shipmentLeadId, {
                ...normalized.lastPosition,
                shipmentId: input.shipmentLeadId,
            });
        }

        await recordEvent({
            provider: "carrier_view",
            eventType: "load_created",
            providerLoadId: row.providerLoadId,
            shipmentLeadId: input.shipmentLeadId,
            trackingId: row.trackingId,
            payload: {
                providerLoadId: row.providerLoadId,
                externalLoadRef: row.externalLoadRef,
            },
        });

        await domainEventEngine.emit({
            shipmentLeadId: input.shipmentLeadId,
            eventType: "TRACKING_STARTED",
            title: "CarrierView tracking started",
            message: `GPS tracking active for ${phone}`,
            actorUserId: input.actorUserId,
            payload: {
                provider: "carrier_view",
                providerLoadId: row.providerLoadId,
                trackingUrl: row.trackingUrl,
            },
            timelineStage: "DISPATCH",
        });

        return row;
    }

    async refreshFromProvider(shipmentLeadId: string, actorUserId?: string) {
        const row = await this.getActiveTracking(shipmentLeadId);
        if (!row) throw Object.assign(new Error("No active tracking for this Load"), { status: 404 });
        const provider = getTrackingProvider(row.provider);
        const normalized = await provider.getLoad(row.providerLoadId);
        const updated = await prisma.shipmentTracking.update({
            where: { trackingId: row.trackingId },
            data: applyLoadSnapshot(normalized),
        });
        if (normalized.lastPosition) {
            await storePosition(row.trackingId, shipmentLeadId, {
                ...normalized.lastPosition,
                shipmentId: shipmentLeadId,
            });
        }
        await recordEvent({
            provider: row.provider,
            eventType: "load_refreshed",
            providerLoadId: row.providerLoadId,
            shipmentLeadId,
            trackingId: row.trackingId,
            payload: { actorUserId },
        });
        return updated;
    }

    async disableTracking(shipmentLeadId: string, actorUserId?: string) {
        const row = await this.getActiveTracking(shipmentLeadId);
        if (!row) return null;
        try {
            await getTrackingProvider(row.provider).disableLoad(row.providerLoadId);
        } catch (err) {
            console.warn(
                "[CARRIERVIEW_TRACKING] disable failed:",
                carrierViewUserMessage(err)
            );
            await prisma.shipmentTracking.update({
                where: { trackingId: row.trackingId },
                data: {
                    status: "DISABLED",
                    disabledAt: new Date(),
                    lastError: carrierViewUserMessage(err),
                },
            });
            throw err;
        }
        const updated = await prisma.shipmentTracking.update({
            where: { trackingId: row.trackingId },
            data: { status: "DISABLED", disabledAt: new Date(), lastError: null },
        });
        await recordEvent({
            provider: row.provider,
            eventType: "load_disabled",
            providerLoadId: row.providerLoadId,
            shipmentLeadId,
            trackingId: row.trackingId,
            payload: { actorUserId },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "TRACKING_STOPPED",
            title: "CarrierView tracking disabled",
            message: "GPS tracking closed — history retained",
            actorUserId,
            payload: { providerLoadId: row.providerLoadId },
            timelineStage: "COMPLETED",
        });
        return updated;
    }

    async sendChat(shipmentLeadId: string, message: string, actorUserId?: string) {
        const row = await this.getActiveTracking(shipmentLeadId);
        if (!row) throw Object.assign(new Error("No active tracking"), { status: 404 });
        await getTrackingProvider(row.provider).sendDriverMessage(row.providerLoadId, message);
        await recordEvent({
            provider: row.provider,
            eventType: "chat_sent",
            providerLoadId: row.providerLoadId,
            shipmentLeadId,
            trackingId: row.trackingId,
            payload: { message: message.slice(0, 500) },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "DRIVER_CHAT_SENT",
            title: "Message to driver",
            message,
            actorUserId,
            payload: { provider: row.provider },
            timelineStage: "DISPATCH",
        });
    }

    async sendSms(
        shipmentLeadId: string,
        type: "welcome" | "assigned_load" | "one_time_ping_request" | "installation_guide" | "custom",
        message?: string,
        actorUserId?: string
    ) {
        const row = await this.getActiveTracking(shipmentLeadId);
        if (!row) throw Object.assign(new Error("No active tracking"), { status: 404 });
        // SMS is NOT idempotent — never auto-retry here.
        await getTrackingProvider(row.provider).sendDriverSms({
            providerLoadId: row.providerLoadId,
            type,
            message,
        });
        await recordEvent({
            provider: row.provider,
            eventType: "sms_sent",
            providerLoadId: row.providerLoadId,
            shipmentLeadId,
            trackingId: row.trackingId,
            payload: { type, message: message?.slice(0, 480) },
        });
        await domainEventEngine.emit({
            shipmentLeadId,
            eventType: "DRIVER_SMS_SENT",
            title: `Driver SMS (${type})`,
            message: type === "custom" ? message || "" : `Sent ${type} SMS via CarrierView`,
            actorUserId,
            payload: { type },
            timelineStage: "DISPATCH",
        });
    }

    async listPositions(shipmentLeadId: string, limit = 100) {
        return prisma.trackingPosition.findMany({
            where: { shipmentLeadId },
            orderBy: { receivedAt: "desc" },
            take: Math.min(limit, 500),
        });
    }

    /** Dashboard / Load details GPS block. */
    async buildTrackingPayload(shipmentLeadId: string) {
        const sessions = await this.getStatusForShipment(shipmentLeadId);
        const active = sessions.find((s) => s.status === "ACTIVE") || sessions[0] || null;
        const recent = active
            ? await prisma.trackingPosition.findMany({
                  where: { trackingId: active.trackingId },
                  orderBy: { receivedAt: "desc" },
                  take: 50,
              })
            : [];
        return {
            providerReady: listProvidersConfigured(),
            active: active
                ? {
                      trackingId: active.trackingId,
                      provider: active.provider,
                      providerLoadId: active.providerLoadId,
                      status: active.status,
                      driverPhone: active.driverPhone,
                      trackingUrl: active.trackingUrl,
                      clientTrackingUrl: active.clientTrackingUrl,
                      lastLatitude: active.lastLatitude,
                      lastLongitude: active.lastLongitude,
                      lastAddress: active.lastAddress,
                      lastPositionAt: active.lastPositionAt,
                      movementType: active.movementType,
                      driverAppStatus: active.driverAppStatus,
                      routeStarted: active.routeStarted,
                      driverIsLate: active.driverIsLate,
                      timeLeftSec: active.timeLeftSec,
                      distanceLeftMeters: active.distanceLeftMeters,
                      pickupArrivedAt: active.pickupArrivedAt,
                      pickupDepartedAt: active.pickupDepartedAt,
                      destinationArrivedAt: active.destinationArrivedAt,
                      destinationDepartedAt: active.destinationDepartedAt,
                      lastSyncedAt: active.lastSyncedAt,
                      lastError: active.lastError,
                  }
                : null,
            sessions: sessions.map((s) => ({
                trackingId: s.trackingId,
                provider: s.provider,
                providerLoadId: s.providerLoadId,
                status: s.status,
                createdAt: s.createdAt,
            })),
            recentPositions: recent.map((p) => ({
                latitude: p.latitude,
                longitude: p.longitude,
                address: p.address,
                movementType: p.movementType,
                providerTimestamp: p.providerTimestamp,
                receivedAt: p.receivedAt,
            })),
        };
    }

    // --- Webhooks ---

    async handlePositionWebhook(payload: unknown) {
        const body = (payload || {}) as Record<string, unknown>;
        const load = (body.load || {}) as Record<string, unknown>;
        const position = (body.position || {}) as Record<string, unknown>;
        const providerLoadId = load.id != null ? String(load.id) : null;
        console.log(
            `[CARRIERVIEW_WEBHOOK] event=position provider_load_id=${providerLoadId || "unknown"}`
        );

        const event = await recordEvent({
            provider: "carrier_view",
            eventType: "webhook_position",
            providerLoadId,
            payload: { loadId: providerLoadId, position },
            status: "RECEIVED",
        });
        if (event && event.processingStatus === "PROCESSED" && event.processedAt) {
            // duplicate fingerprint already processed earlier in same create path — still try apply
        }

        if (!providerLoadId) {
            await this.markEvent(event?.eventId, "FAILED", "missing load.id");
            return { ok: true, ignored: true };
        }

        const tracking = await prisma.shipmentTracking.findFirst({
            where: { provider: "carrier_view", providerLoadId },
        });
        if (!tracking) {
            console.warn(
                `[CARRIERVIEW_WEBHOOK] unknown CarrierView load ${providerLoadId} — acknowledged`
            );
            await this.markEvent(event?.eventId, "IGNORED", "shipment not found");
            return { ok: true, ignored: true };
        }

        const normalized = {
            shipmentId: tracking.shipmentLeadId,
            provider: "carrier_view" as const,
            providerLoadId,
            driverPhone: position.driver_phone != null ? String(position.driver_phone) : null,
            latitude: Number(position.latitude),
            longitude: Number(position.longitude),
            address: position.address != null ? String(position.address) : null,
            movementType: position.type != null ? String(position.type) : null,
            rotation: position.rotation != null ? Number(position.rotation) : null,
            lateSeconds: position.late_secs != null ? Number(position.late_secs) : null,
            stoppedDuration: position.stopped_duration != null ? Number(position.stopped_duration) : null,
            driveDuration: position.drive_duration != null ? Number(position.drive_duration) : null,
            pausedDuration: position.paused_duration != null ? Number(position.paused_duration) : null,
            timestamp: null as string | null,
        };
        if (!Number.isFinite(normalized.latitude) || !Number.isFinite(normalized.longitude)) {
            await this.markEvent(event?.eventId, "FAILED", "invalid coordinates");
            return { ok: true, ignored: true };
        }

        await storePosition(tracking.trackingId, tracking.shipmentLeadId, normalized);
        await this.syncMilestonesFromLoad(tracking.trackingId, load);
        await this.markEvent(event?.eventId, "PROCESSED");
        return { ok: true, shipmentLeadId: tracking.shipmentLeadId };
    }

    async handleLoadStatusWebhook(payload: unknown) {
        const body = (payload || {}) as Record<string, unknown>;
        const eventName = String(body.event || "load_edited");
        const load = (body.load || {}) as Record<string, unknown>;
        const providerLoadId = load.id != null ? String(load.id) : null;
        console.log(
            `[CARRIERVIEW_WEBHOOK] event=${eventName} provider_load_id=${providerLoadId || "unknown"}`
        );

        const event = await recordEvent({
            provider: "carrier_view",
            eventType: `webhook_${eventName}`,
            providerLoadId,
            payload: body,
            status: "RECEIVED",
        });

        if (!providerLoadId) {
            await this.markEvent(event?.eventId, "FAILED", "missing load.id");
            return { ok: true, ignored: true };
        }

        let tracking = await prisma.shipmentTracking.findFirst({
            where: { provider: "carrier_view", providerLoadId },
        });

        if (eventName === "load_deleted") {
            if (tracking) {
                await prisma.shipmentTracking.update({
                    where: { trackingId: tracking.trackingId },
                    data: { status: "DELETED", disabledAt: new Date() },
                });
                // Never delete Green OS shipment
            }
            await this.markEvent(event?.eventId, "PROCESSED");
            return { ok: true };
        }

        if (!tracking && eventName === "load_added") {
            // Orphan CarrierView load — log only (cannot invent Green OS shipment)
            await this.markEvent(event?.eventId, "IGNORED", "no matching Green OS tracking");
            return { ok: true, ignored: true };
        }

        if (!tracking) {
            await this.markEvent(event?.eventId, "IGNORED", "tracking not found");
            return { ok: true, ignored: true };
        }

        const provider = getTrackingProvider("carrier_view");
        try {
            const normalized = await provider.getLoad(providerLoadId);
            await prisma.shipmentTracking.update({
                where: { trackingId: tracking.trackingId },
                data: { ...applyLoadSnapshot(normalized), status: "ACTIVE" },
            });
            await this.syncMilestonesFromLoad(tracking.trackingId, load);
        } catch (err) {
            await prisma.shipmentTracking.update({
                where: { trackingId: tracking.trackingId },
                data: { lastError: carrierViewUserMessage(err) },
            });
        }
        await this.markEvent(event?.eventId, "PROCESSED");
        return { ok: true, shipmentLeadId: tracking.shipmentLeadId };
    }

    async handleChatWebhook(payload: unknown) {
        const body = (payload || {}) as Record<string, unknown>;
        const load = (body.load || {}) as Record<string, unknown>;
        const message = (body.message || {}) as Record<string, unknown>;
        const providerLoadId = load.id != null ? String(load.id) : null;
        const text = message.text != null ? String(message.text) : "";
        console.log(
            `[CARRIERVIEW_WEBHOOK] event=chat provider_load_id=${providerLoadId || "unknown"}`
        );

        const event = await recordEvent({
            provider: "carrier_view",
            eventType: "webhook_chat",
            providerLoadId,
            payload: body,
            status: "RECEIVED",
        });

        const tracking = providerLoadId
            ? await prisma.shipmentTracking.findFirst({
                  where: { provider: "carrier_view", providerLoadId },
              })
            : null;

        if (!tracking) {
            // Keep raw event for reconciliation — do not lose message
            await this.markEvent(event?.eventId, "IGNORED", "shipment not found — raw retained");
            return { ok: true, ignored: true };
        }

        await domainEventEngine.emit({
            shipmentLeadId: tracking.shipmentLeadId,
            eventType: "DRIVER_CHAT_RECEIVED",
            title: "Driver message (CarrierView)",
            message: text,
            payload: {
                provider: "carrier_view",
                providerLoadId,
                createdAtUtc: message.created_at_utc || null,
            },
            timelineStage: "DISPATCH",
        });
        await this.markEvent(event?.eventId, "PROCESSED");
        return { ok: true, shipmentLeadId: tracking.shipmentLeadId };
    }

    private async markEvent(eventId: string | undefined, status: string, errorMessage?: string) {
        if (!eventId) return;
        await prisma.trackingIntegrationEvent
            .update({
                where: { eventId },
                data: {
                    processingStatus: status,
                    errorMessage: errorMessage || null,
                    processedAt: new Date(),
                },
            })
            .catch(() => null);
    }

    private async syncMilestonesFromLoad(trackingId: string, load: Record<string, unknown>) {
        const data: Record<string, unknown> = {};
        if (load.delivery_arrived) data.destinationArrivedAt = new Date(String(load.delivery_arrived));
        if (load.delivery_departed) data.destinationDepartedAt = new Date(String(load.delivery_departed));
        // CarrierView may use pickup_* naming — store when present
        if (load.pickup_arrived) data.pickupArrivedAt = new Date(String(load.pickup_arrived));
        if (load.pickup_departed) data.pickupDepartedAt = new Date(String(load.pickup_departed));
        if (load.route_started != null) data.routeStarted = Boolean(load.route_started);
        if (load.driver_is_late != null) data.driverIsLate = Boolean(load.driver_is_late);
        if (load.time_left_sec != null) data.timeLeftSec = Number(load.time_left_sec);
        if (load.distance_left_meters != null) {
            data.distanceLeftMeters = Number(load.distance_left_meters);
        }
        if (load.track_driver != null) data.driverAppStatus = String(load.track_driver);
        if (Object.keys(data).length) {
            await prisma.shipmentTracking.update({ where: { trackingId }, data });
        }
    }

    async reconcileActive() {
        if (!config.carrierView.enabled || !carrierViewClient.isConfigured()) return { checked: 0 };
        const active = await prisma.shipmentTracking.findMany({
            where: { provider: "carrier_view", status: "ACTIVE" },
            take: 40,
            orderBy: { lastSyncedAt: "asc" },
        });
        console.log(`[CARRIERVIEW_RECONCILIATION] checking=${active.length}`);
        let updated = 0;
        for (const row of active) {
            try {
                const normalized = await getTrackingProvider("carrier_view").getLoad(row.providerLoadId);
                await prisma.shipmentTracking.update({
                    where: { trackingId: row.trackingId },
                    data: applyLoadSnapshot(normalized),
                });
                if (normalized.lastPosition) {
                    await storePosition(row.trackingId, row.shipmentLeadId, {
                        ...normalized.lastPosition,
                        shipmentId: row.shipmentLeadId,
                    });
                }
                updated += 1;
            } catch (err) {
                const msg = carrierViewUserMessage(err);
                console.warn(
                    `[CARRIERVIEW_RECONCILIATION] fail provider_load_id=${row.providerLoadId} ${msg}`
                );
                const deleted = /load_not_found/i.test(msg);
                await prisma.shipmentTracking.update({
                    where: { trackingId: row.trackingId },
                    data: {
                        lastError: msg,
                        ...(deleted ? { status: "DELETED", disabledAt: new Date() } : {}),
                    },
                });
            }
        }
        return { checked: active.length, updated };
    }

    async adminConnectionStatus() {
        const configured = carrierViewClient.isConfigured();
        let healthy: boolean | null = null;
        let profile: unknown = null;
        let error: string | null = null;
        if (configured && config.carrierView.enabled) {
            try {
                const res = await carrierViewClient.getProfile();
                healthy = true;
                profile = res.data ?? { success: true };
            } catch (err) {
                healthy = false;
                error = carrierViewUserMessage(err);
            }
        }
        return {
            enabled: config.carrierView.enabled,
            tokenConfigured: Boolean(config.carrierView.apiToken),
            baseUrlConfigured: Boolean(config.carrierView.apiBaseUrl),
            baseUrlHost: config.carrierView.apiBaseUrl
                ? (() => {
                      try {
                          return new URL(config.carrierView.apiBaseUrl).host;
                      } catch {
                          return "(invalid url)";
                      }
                  })()
                : null,
            healthy,
            error,
            profileSummary: profile
                ? { connected: true }
                : { connected: false },
            webhooks: {
                position: webhookUrl("position"),
                loadStatus: webhookUrl("load-status"),
                chat: webhookUrl("chat"),
            },
            reconciliationIntervalSeconds: config.carrierView.reconciliationIntervalSeconds,
        };
    }

    async registerWebhooks(actorUserId?: string) {
        if (!carrierViewClient.isConfigured()) {
            throw Object.assign(new Error("CarrierView not configured"), { status: 503 });
        }
        const urls = {
            position: webhookUrl("position"),
            loadStatus: webhookUrl("load-status"),
            chat: webhookUrl("chat"),
        };
        await carrierViewClient.setPositionWebhook(urls.position);
        await carrierViewClient.setLoadStatusWebhook(urls.loadStatus);
        await carrierViewClient.setChatWebhook(urls.chat);
        await recordEvent({
            provider: "carrier_view",
            eventType: "webhooks_registered",
            payload: { urls, actorUserId },
        });
        return urls;
    }
}

function webhookUrl(type: "position" | "load-status" | "chat") {
    const base = config.publicAppUrl.replace(/\/$/, "");
    const path = `/api/integrations/carrier-view/webhooks/${type}`;
    const secret = config.carrierView.webhookSecret;
    return secret ? `${base}${path}?k=${encodeURIComponent(secret)}` : `${base}${path}`;
}

function listProvidersConfigured() {
    return {
        carrier_view: {
            enabled: config.carrierView.enabled,
            configured: carrierViewClient.isConfigured(),
        },
        motive: { enabled: false, configured: false },
        samsara: { enabled: false, configured: false },
        verizon: { enabled: false, configured: false },
    };
}

export const trackingService = new TrackingService();

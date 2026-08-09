import type {
    CreateTrackingLoadInput,
    EditTrackingLoadInput,
    SendSmsInput,
    TrackingProvider,
} from "../../types.js";
import { carrierViewClient } from "./client.js";
import { CarrierViewLoadNotFound, CarrierViewValidationError } from "./errors.js";
import {
    CARRIER_VIEW_PROVIDER,
    normalizeCarrierViewLoad,
    normalizeCarrierViewPosition,
    toCarrierViewCreateBody,
    toCarrierViewPatchBody,
} from "./mapper.js";

function asRecord(data: unknown): Record<string, unknown> {
    if (data && typeof data === "object" && !Array.isArray(data)) {
        return data as Record<string, unknown>;
    }
    if (data && typeof data === "object" && Array.isArray(data) && data[0]) {
        return data[0] as Record<string, unknown>;
    }
    return {};
}

function unwrapLoad(data: unknown): Record<string, unknown> {
    const root = asRecord(data);
    if (root.load && typeof root.load === "object") return root.load as Record<string, unknown>;
    if (root.data && typeof root.data === "object") {
        const inner = root.data as Record<string, unknown>;
        if (inner.load && typeof inner.load === "object") return inner.load as Record<string, unknown>;
        if (inner.id != null) return inner;
    }
    if (root.id != null) return root;
    return root;
}

export class CarrierViewProvider implements TrackingProvider {
    readonly id = CARRIER_VIEW_PROVIDER;

    async createLoad(input: CreateTrackingLoadInput) {
        if (!input.driverPhone) throw new CarrierViewValidationError({ driver_phone: "required" });
        if (!input.locations || input.locations.length < 2) {
            throw new CarrierViewValidationError({ locations: "at least pickup + destination required" });
        }
        const res = await carrierViewClient.createLoad(
            toCarrierViewCreateBody({
                driverPhone: input.driverPhone,
                externalLoadRef: input.externalLoadRef,
                locations: input.locations,
                startsActiveMinutes: input.startsActiveMinutes,
                emails: input.emails,
                dispatchers: input.dispatchers,
            })
        );
        const load = unwrapLoad(res.data ?? res);
        if (!load.id) throw new CarrierViewValidationError({ id: "missing in create response" });
        return normalizeCarrierViewLoad(load, input.shipmentLeadId);
    }

    async getLoad(providerLoadId: string) {
        const res = await carrierViewClient.getLoad(providerLoadId);
        const load = unwrapLoad(res.data ?? res);
        if (!load.id) throw new CarrierViewLoadNotFound({ providerLoadId });
        return normalizeCarrierViewLoad(load);
    }

    async updateLoad(input: EditTrackingLoadInput) {
        const body = toCarrierViewPatchBody({
            mcNumber: input.mcNumber,
            emails: input.emails,
            dispatchers: input.dispatchers,
            locations: input.locations,
            includeEmails: input.emails !== undefined,
            includeDispatchers: input.dispatchers !== undefined,
            includeLocations: Boolean(input.locations && input.locations.length),
        });
        if (!Object.keys(body).length) {
            return this.getLoad(input.providerLoadId);
        }
        const res = await carrierViewClient.editLoad(input.providerLoadId, body);
        const load = unwrapLoad(res.data ?? res);
        return normalizeCarrierViewLoad(load);
    }

    async disableLoad(providerLoadId: string) {
        await carrierViewClient.disableLoad(providerLoadId);
    }

    async getLastPosition(providerLoadId: string, shipmentId: string) {
        const res = await carrierViewClient.getLastPosition(providerLoadId);
        const data = asRecord(res.data ?? res);
        const position =
            data.position && typeof data.position === "object"
                ? (data.position as Record<string, unknown>)
                : data;
        return normalizeCarrierViewPosition(position, { shipmentId, providerLoadId });
    }

    async getPositionHistory(
        providerLoadId: string,
        shipmentId: string,
        opts?: { page?: number; perPage?: number; order?: "asc" | "desc" }
    ) {
        const res = await carrierViewClient.getPositionsHistory(providerLoadId, {
            page: opts?.page,
            per_page: opts?.perPage,
            order: opts?.order,
        });
        const data = res.data as unknown;
        let rows: unknown[] = [];
        if (Array.isArray(data)) rows = data;
        else if (data && typeof data === "object") {
            const obj = data as Record<string, unknown>;
            if (Array.isArray(obj.positions)) rows = obj.positions;
            else if (Array.isArray(obj.data)) rows = obj.data;
            else if (Array.isArray(obj.items)) rows = obj.items;
        }
        return rows
            .map((row) =>
                normalizeCarrierViewPosition(row as Record<string, unknown>, {
                    shipmentId,
                    providerLoadId,
                })
            )
            .filter((p): p is NonNullable<typeof p> => Boolean(p));
    }

    async sendDriverMessage(providerLoadId: string, message: string) {
        await carrierViewClient.sendChatMessage(providerLoadId, message);
    }

    async sendDriverSms(input: SendSmsInput) {
        if (input.type === "custom" && input.message && input.message.length > 480) {
            throw new CarrierViewValidationError({ message: "max 480 characters" });
        }
        const body: { type: string; message?: string } = { type: input.type };
        if (input.type === "custom") body.message = input.message || "";
        await carrierViewClient.sendTextMessage(input.providerLoadId, body);
    }
}

export const carrierViewProvider = new CarrierViewProvider();

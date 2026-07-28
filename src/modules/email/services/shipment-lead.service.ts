import type { ParsedShipmentDraft } from "../models/types.js";
import {
    shipmentImportLogRepository,
    shipmentLeadRepository,
} from "./repositories.js";
import { assignmentEngine } from "../../assignment/assignment.engine.js";
import { allocateGreenOsShipmentId } from "../../shipment/shipment.id.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";

/**
 * Shipment lead create + list. Assignment / acceptance pipeline lives in Assignment Engine v1.0.
 * Aggregate Root is Shipment (Sprint A) — permanent greenOsShipmentId on the same card.
 */
export class ShipmentLeadService {
    async createFromParsed(input: {
        draft: ParsedShipmentDraft;
        emailMessageId: string;
        gmailMessageId: string;
    }) {
        const { draft, emailMessageId, gmailMessageId } = input;

        if (draft.viewUrl) {
            const byUrl = await shipmentLeadRepository.findByViewUrl(draft.viewUrl);
            if (byUrl) {
                await shipmentImportLogRepository.create({
                    eventType: "DuplicateShipment",
                    message: `Duplicate by viewUrl: ${draft.viewUrl}`,
                    gmailMessageId,
                    emailMessageId,
                    shipmentLeadId: byUrl.shipmentLeadId,
                });
                return { duplicate: true as const, lead: byUrl };
            }
        }

        if (draft.externalShipmentId) {
            const byExternal = await shipmentLeadRepository.findByExternalId(
                draft.source,
                draft.externalShipmentId
            );
            if (byExternal) {
                await shipmentImportLogRepository.create({
                    eventType: "DuplicateShipment",
                    message: `Duplicate by externalShipmentId: ${draft.externalShipmentId}`,
                    gmailMessageId,
                    emailMessageId,
                    shipmentLeadId: byExternal.shipmentLeadId,
                });
                return { duplicate: true as const, lead: byExternal };
            }
        }

        const greenOsShipmentId = await allocateGreenOsShipmentId();

        const lead = await shipmentLeadRepository.create({
            greenOsShipmentId,
            source: draft.source,
            externalShipmentId: draft.externalShipmentId,
            shipmentTitle: draft.shipmentTitle,
            pickupCity: draft.pickupCity,
            pickupState: draft.pickupState,
            pickupZip: draft.pickupZip,
            deliveryCity: draft.deliveryCity,
            deliveryState: draft.deliveryState,
            deliveryZip: draft.deliveryZip,
            pickupFrom: draft.pickupFrom || undefined,
            pickupTo: draft.pickupTo || undefined,
            deliveryFrom: draft.deliveryFrom || undefined,
            deliveryTo: draft.deliveryTo || undefined,
            miles: draft.miles ?? undefined,
            category: draft.category,
            imageUrl: draft.imageUrl,
            viewUrl: draft.viewUrl,
            status: "NEW",
            emailMessageId,
            receivedAt: draft.receivedAt || new Date(),
        });

        await shipmentImportLogRepository.create({
            eventType: "EmailImported",
            message: `Imported shipment ${greenOsShipmentId}: ${lead.shipmentTitle}`,
            gmailMessageId,
            emailMessageId,
            shipmentLeadId: lead.shipmentLeadId,
        });

        await shipmentService.markImported(lead.shipmentLeadId, {
            source: draft.source,
            externalShipmentId: draft.externalShipmentId,
            gmailMessageId,
            greenOsShipmentId,
        });

        await assignmentEngine.startPipeline(lead.shipmentLeadId);
        const refreshed = await shipmentLeadRepository.findById(lead.shipmentLeadId);
        return { duplicate: false as const, lead: refreshed || lead };
    }

    list(limit?: number) {
        return shipmentLeadRepository.list(limit);
    }

    getById(id: string) {
        return shipmentLeadRepository.findById(id);
    }

    get assignment() {
        return assignmentEngine;
    }
}

export const shipmentLeadService = new ShipmentLeadService();
export { assignmentEngine };

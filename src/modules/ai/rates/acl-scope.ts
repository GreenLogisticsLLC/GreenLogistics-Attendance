import { isDataScopedRole, isTeamScopedRole } from "../../../auth/roles.js";
import { listTeamBrokerIds } from "../../../auth/team-scope.js";
import { EXCLUDED_SHIPMENT_STATUSES, HISTORICAL_FETCH_LIMIT, MIN_VALID_RATE } from "./constants.js";
import type { RateActor } from "./types.js";

/**
 * ACL filter applied BEFORE historical dataset fetch / statistics.
 * Broker → own shipments only.
 * Team Lead → team broker shipments.
 * Admin/Owner/Manager → all broker-assigned shipments.
 */
export async function buildHistoricalAclWhere(actor: RateActor): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = {
        carrierRate: { gte: MIN_VALID_RATE },
        miles: { gt: 0 },
        status: { notIn: [...EXCLUDED_SHIPMENT_STATUSES] },
        pickupCity: { not: null },
        deliveryCity: { not: null },
    };

    if (isDataScopedRole(actor.role)) {
        return { ...base, assignedBrokerId: actor.userId };
    }

    if (isTeamScopedRole(actor.role)) {
        const ids = await listTeamBrokerIds(actor.userId);
        return {
            ...base,
            assignedBrokerId: { in: ids.length ? ids : ["__none__"] },
        };
    }

    return { ...base, assignedBrokerId: { not: null } };
}

export const SHIPMENT_RATE_SELECT = {
    shipmentLeadId: true,
    loadNumber: true,
    greenOsShipmentId: true,
    pickupCity: true,
    pickupState: true,
    pickupZip: true,
    deliveryCity: true,
    deliveryState: true,
    deliveryZip: true,
    equipment: true,
    miles: true,
    weight: true,
    carrierRate: true,
    carrierProfileId: true,
    pickupFrom: true,
    deliveryFrom: true,
    status: true,
    assignedBrokerId: true,
} as const;

export { HISTORICAL_FETCH_LIMIT };

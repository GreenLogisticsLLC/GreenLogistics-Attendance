import type { Prisma } from "@prisma/client";
import { arrivedAfterShipmentCutoff } from "../../services/shipment-cutoff.js";

const WAITING_FOR_BROKER = [
    "NEW",
    "UNASSIGNED",
    "ASSIGNED",
    "AWAITING_ACCEPTANCE",
    "AGENT_OPEN",
];

/**
 * Shipments still waiting for a broker who can take them.
 * Includes rows with no broker, and rows parked on someone who is not eligible now.
 */
export function unassignedShipmentWhere(
    eligibleBrokerIds: string[],
    teamBrokerIds?: string[] | null
): Prisma.ShipmentLeadWhereInput {
    const noBroker = [{ assignedBrokerId: null }, { assignedBrokerId: "" }];
    const eligible = new Set(eligibleBrokerIds);
    const ineligibleTeam = teamBrokerIds
        ? teamBrokerIds.filter((id) => !eligible.has(id))
        : null;
    const heldBySomeoneElse =
        ineligibleTeam != null
            ? ineligibleTeam.length
                ? [{ assignedBrokerId: { in: ineligibleTeam } }]
                : []
            : eligibleBrokerIds.length > 0
              ? [{ assignedBrokerId: { notIn: eligibleBrokerIds } }]
              : [{ NOT: { assignedBrokerId: null } }];
    return {
        AND: [
            arrivedAfterShipmentCutoff,
            { acceptedAt: null },
            { status: { in: WAITING_FOR_BROKER } },
            { OR: [...noBroker, ...heldBySomeoneElse] },
        ],
    };
}

/** Awaiting Accept only while the current broker is eligible to take it. */
export function awaitingAcceptWhere(
    eligibleBrokerIds: string[]
): Prisma.ShipmentLeadWhereInput {
    return {
        AND: [
            arrivedAfterShipmentCutoff,
            { acceptedAt: null },
            { status: "AWAITING_ACCEPTANCE" },
            {
                assignedBrokerId: {
                    in: eligibleBrokerIds.length ? eligibleBrokerIds : ["__none__"],
                },
            },
        ],
    };
}

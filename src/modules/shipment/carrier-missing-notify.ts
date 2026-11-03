import { prisma } from "../../config/database.js";
import { config } from "../../config/env.js";
import { carrierMissingOnPickup, carrierMissingRecipients, companyDateKey } from "./carrier-missing-on-pickup.js";

const NOTIFICATION_TYPE = "CARRIER_MISSING_ON_PICKUP";

/**
 * On the pickup day, a load with no carrier notifies that broker's Team Lead and Managers.
 * One alert per person per load.
 */
export async function notifyCarrierMissingOnPickup(now = new Date()): Promise<number> {
    const rows = await prisma.shipmentLead.findMany({
        where: {
            loadNumber: { not: null },
            status: {
                notIn: ["COMPLETED", "CLOSED", "LOST", "DELETED_FROM_CUSTOMER", "ACCEPTED_ANOTHER_COMPANY"],
            },
            OR: [{ carrierName: null }, { carrierName: "" }],
            AND: [
                {
                    OR: [{ pickupFrom: { not: null } }, { opsPickupAt: { not: null } }],
                },
            ],
        },
        select: {
            shipmentLeadId: true,
            loadNumber: true,
            shipmentTitle: true,
            carrierName: true,
            status: true,
            pickupFrom: true,
            opsPickupAt: true,
            assignedBrokerId: true,
        },
        take: 300,
    });
    const due = rows.filter((row) =>
        carrierMissingOnPickup({
            loadNumber: row.loadNumber,
            carrierName: row.carrierName,
            status: row.status,
            pickupFrom: row.pickupFrom,
            opsPickupAt: row.opsPickupAt,
            now,
            timeZone: config.timezone,
        })
    );
    if (!due.length) return 0;

    const managers = await prisma.user.findMany({
        where: { isActive: true, role: { roleName: "Manager" } },
        select: { userId: true },
    });
    const brokerIds = [...new Set(due.map((row) => row.assignedBrokerId).filter(Boolean))] as string[];
    const brokers = brokerIds.length
        ? await prisma.user.findMany({
              where: { userId: { in: brokerIds } },
              select: {
                  userId: true,
                  teamLeadId: true,
                  role: { select: { roleName: true } },
              },
          })
        : [];
    const brokerById = new Map(brokers.map((broker) => [broker.userId, broker]));

    const existing = await prisma.platformNotification.findMany({
        where: {
            notificationType: NOTIFICATION_TYPE,
            shipmentLeadId: { in: due.map((row) => row.shipmentLeadId) },
        },
        select: { userId: true, shipmentLeadId: true },
    });
    const sent = new Set(existing.map((row) => `${row.shipmentLeadId}:${row.userId}`));

    const data: Array<{
        userId: string;
        shipmentLeadId: string;
        notificationType: string;
        title: string;
        message: string;
        metaJson: string;
    }> = [];
    for (const row of due) {
        const broker = row.assignedBrokerId ? brokerById.get(row.assignedBrokerId) : undefined;
        const recipients = carrierMissingRecipients({
            brokerUserId: broker?.userId,
            brokerRole: broker?.role?.roleName,
            brokerTeamLeadId: broker?.teamLeadId,
            managerUserIds: managers.map((manager) => manager.userId),
        });
        const pickup = row.opsPickupAt || row.pickupFrom;
        const day = pickup ? companyDateKey(pickup, config.timezone) : "";
        const title = "No carrier on pickup day";
        const message = `Load ${row.loadNumber} (${row.shipmentTitle || "shipment"}) pickup ${day} still has no carrier registered.`;
        for (const userId of recipients) {
            const key = `${row.shipmentLeadId}:${userId}`;
            if (sent.has(key)) continue;
            sent.add(key);
            data.push({
                userId,
                shipmentLeadId: row.shipmentLeadId,
                notificationType: NOTIFICATION_TYPE,
                title,
                message,
                metaJson: JSON.stringify({ loadNumber: row.loadNumber, pickupDay: day }),
            });
        }
    }
    if (!data.length) return 0;
    await prisma.platformNotification.createMany({ data });
    return data.length;
}

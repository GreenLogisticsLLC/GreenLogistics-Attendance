/** 17:38 Asia/Yerevan, 2 Nov 2026. Older shipments are not kept or assigned. */
export const SHIPMENTS_FROM = new Date("2026-11-02T13:38:00.000Z");

/** Prisma filter: email time, or created time when the email time is missing. */
export const arrivedAfterShipmentCutoff = {
    OR: [
        { receivedAt: { gte: SHIPMENTS_FROM } },
        { AND: [{ receivedAt: null }, { createdAt: { gte: SHIPMENTS_FROM } }] },
    ],
};

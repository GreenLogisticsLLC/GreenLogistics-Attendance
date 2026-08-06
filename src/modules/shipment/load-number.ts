import { prisma } from "../../config/database.js";

/** First load number in the Green OS series (75698, 75699, …). */
export const LOAD_NUMBER_START = parseInt(process.env.LOAD_NUMBER_START || "75698", 10);

/**
 * Allocate the next company Load Number (numeric sequence starting at LOAD_NUMBER_START).
 * Never reused. Stored on the same Shipment card — never creates a separate Load entity.
 */
export async function allocateLoadNumber(): Promise<string> {
    const start = Number.isFinite(LOAD_NUMBER_START) && LOAD_NUMBER_START > 0 ? LOAD_NUMBER_START : 75698;

    for (let attempt = 0; attempt < 12; attempt++) {
        const setting = await prisma.setting.findUnique({
            where: {
                category_settingKey: { category: "shipment", settingKey: "next_load_number" },
            },
        });

        let next = start;
        if (setting?.settingValue && /^\d+$/.test(setting.settingValue)) {
            next = Math.max(start, parseInt(setting.settingValue, 10));
        } else {
            // Bootstrap from the highest existing numeric load number in the series.
            const rows = await prisma.shipmentLead.findMany({
                where: { loadNumber: { not: null } },
                select: { loadNumber: true },
            });
            let max = start - 1;
            for (const row of rows) {
                const raw = String(row.loadNumber || "").trim();
                if (!/^\d+$/.test(raw)) continue;
                const n = parseInt(raw, 10);
                if (n >= start - 1 && n > max) max = n;
            }
            next = Math.max(start, max + 1);
        }

        const candidate = String(next);
        const clash = await prisma.shipmentLead.findFirst({
            where: { loadNumber: candidate },
            select: { shipmentLeadId: true },
        });

        await prisma.setting.upsert({
            where: {
                category_settingKey: { category: "shipment", settingKey: "next_load_number" },
            },
            create: {
                category: "shipment",
                settingKey: "next_load_number",
                settingValue: String(next + 1),
                description: "Next Green OS Load Number in the 75698… series",
            },
            update: { settingValue: String(next + 1) },
        });

        if (!clash) return candidate;
    }

    return String(start + Date.now() % 100000);
}

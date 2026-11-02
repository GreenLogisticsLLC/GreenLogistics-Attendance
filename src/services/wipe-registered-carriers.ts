import fs from "fs";
import path from "path";
import { prisma } from "../config/database.js";
import { CARRIER_UPLOADS_ROOT } from "../modules/carriers/services/carrier-storage.service.js";

const MARK = "2026-11-03-wipe-carriers";

function removeCarrierFiles(carrierIds: string[]) {
    const roots = [
        CARRIER_UPLOADS_ROOT,
        path.join(process.cwd(), "uploads", "carriers"),
    ];
    for (const root of roots) {
        for (const carrierId of carrierIds) {
            const dir = path.join(root, carrierId);
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (err) {
                console.warn("[carriers] file delete skipped:", dir, err);
            }
        }
    }
}

/**
 * Remove every registered Carrier (onboarding, documents, signatures).
 * Shipment cards keep their text fields; the carrier profile link is cleared.
 * Runs once.
 */
export async function wipeRegisteredCarriers(): Promise<void> {
    const existing = await prisma.setting.findUnique({
        where: {
            category_settingKey: { category: "ops", settingKey: "carriers_wiped" },
        },
    });
    if (existing?.settingValue === MARK) return;

    const carriers = await prisma.carrier.findMany({ select: { carrierId: true } });
    const ids = carriers.map((row) => row.carrierId);

    await prisma.shipmentLead.updateMany({
        where: { carrierProfileId: { not: null } },
        data: { carrierProfileId: null },
    });

    if (ids.length) {
        const jobs = await prisma.aiDocumentJob.findMany({
            where: {
                OR: [{ carrierId: { in: ids } }, { documentSource: "CARRIER" }],
            },
            select: { jobId: true },
        });
        const jobIds = jobs.map((job) => job.jobId);
        if (jobIds.length) {
            await prisma.aiDocumentJob.deleteMany({ where: { jobId: { in: jobIds } } });
        }
        removeCarrierFiles(ids);
        await prisma.carrier.deleteMany({ where: { carrierId: { in: ids } } });
    }

    await prisma.setting.upsert({
        where: {
            category_settingKey: { category: "ops", settingKey: "carriers_wiped" },
        },
        create: {
            category: "ops",
            settingKey: "carriers_wiped",
            settingValue: MARK,
            description: "All registered carriers were removed",
        },
        update: { settingValue: MARK },
    });
    console.log(`[carriers] Removed ${ids.length} registered carrier(s).`);
}

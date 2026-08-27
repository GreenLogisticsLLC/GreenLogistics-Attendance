import { prisma } from "../../../config/database.js";

const GMAIL_CATEGORY = "gmail";
const IMPORT_AFTER_KEY = "import_after";

/** ISO timestamp — company inbox imports only messages received at/after this instant. */
export async function getCompanyImportAfter(): Promise<Date | null> {
    const row = await prisma.setting.findUnique({
        where: {
            category_settingKey: {
                category: GMAIL_CATEGORY,
                settingKey: IMPORT_AFTER_KEY,
            },
        },
    });
    const raw = (row?.settingValue || "").trim();
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

export async function setCompanyImportAfter(
    when: Date,
    updatedBy?: string | null
): Promise<Date> {
    const iso = when.toISOString();
    await prisma.setting.upsert({
        where: {
            category_settingKey: {
                category: GMAIL_CATEGORY,
                settingKey: IMPORT_AFTER_KEY,
            },
        },
        update: {
            settingValue: iso,
            description: "Only import company Gmail messages received at/after this time",
            updatedBy: updatedBy || null,
        },
        create: {
            category: GMAIL_CATEGORY,
            settingKey: IMPORT_AFTER_KEY,
            settingValue: iso,
            description: "Only import company Gmail messages received at/after this time",
            updatedBy: updatedBy || null,
        },
    });
    return when;
}

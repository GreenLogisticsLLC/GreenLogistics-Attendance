import { prisma } from "../config/database.js";
import { config } from "../config/env.js";

const LEGACY_CATEGORY = "legacy";

export class SettingsService {
    async getLegacyConfig() {
        const rows = await prisma.setting.findMany({
            where: { category: LEGACY_CATEGORY },
        });
        const map = Object.fromEntries(rows.map((r) => [r.settingKey, r.settingValue]));

        return {
            apiUrl: map.api_url || config.legacyApiUrl,
            ingestToken: map.ingest_token || config.legacyIngestToken,
            autoSync: map.auto_sync === "true",
        };
    }

    async getIntegrationSettings() {
        const legacy = await this.getLegacyConfig();
        return {
            legacyApiUrl: legacy.apiUrl,
            legacyIngestTokenConfigured: Boolean(legacy.ingestToken),
            legacyAutoSync: legacy.autoSync,
            webhookSecretConfigured: Boolean(config.webhookSecret),
            timezone: config.timezone,
            companyName: config.companyName,
            databaseProvider: process.env.DATABASE_URL?.startsWith("postgresql")
                ? "postgresql"
                : "sqlite",
        };
    }

    async updateLegacyConfig(
        data: { apiUrl?: string; ingestToken?: string; autoSync?: boolean },
        updatedBy?: string
    ) {
        const updates: Array<[string, string]> = [];
        if (data.apiUrl !== undefined) updates.push(["api_url", data.apiUrl]);
        if (data.ingestToken !== undefined) updates.push(["ingest_token", data.ingestToken]);
        if (data.autoSync !== undefined) updates.push(["auto_sync", String(data.autoSync)]);

        for (const [key, value] of updates) {
            await prisma.setting.upsert({
                where: { category_settingKey: { category: LEGACY_CATEGORY, settingKey: key } },
                update: { settingValue: value, updatedBy },
                create: {
                    category: LEGACY_CATEGORY,
                    settingKey: key,
                    settingValue: value,
                    description: `Legacy Reader ${key}`,
                    updatedBy,
                },
            });
        }

        return this.getLegacyConfig();
    }
}

export const settingsService = new SettingsService();

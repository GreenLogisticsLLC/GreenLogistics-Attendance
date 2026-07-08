import { prisma } from "../config/database.js";
import { normalizeCardToken } from "../utils/helpers.js";

export class CardRegistrationService {
    async recordUnknownScan(token: string, deviceId: string, scannedAt: Date) {
        const cardToken = normalizeCardToken(token);
        if (!cardToken) return;

        const employees = await prisma.employee.findMany({ where: { status: "ACTIVE" } });
        const alreadyRegistered = employees.some(
            (e) => normalizeCardToken(e.cardNumber) === cardToken
        );
        if (alreadyRegistered) return;

        try {
            await prisma.pendingCardScan.upsert({
                where: { cardToken },
                update: {
                    deviceId,
                    scannedAt,
                    registered: false,
                },
                create: {
                    cardToken,
                    deviceId,
                    scannedAt,
                },
            });
        } catch (error) {
            console.error("Could not save pending card scan — run RESTART.bat", error);
        }
    }

    async listPending() {
        try {
            return await prisma.pendingCardScan.findMany({
                where: { registered: false },
                orderBy: { scannedAt: "desc" },
                take: 20,
            });
        } catch (error) {
            console.error("pending_card_scans table unavailable — run RESTART.bat", error);
            return [];
        }
    }

    async markRegistered(cardToken: string) {
        const normalized = normalizeCardToken(cardToken);
        await prisma.pendingCardScan.updateMany({
            where: { cardToken: normalized },
            data: { registered: true },
        });
    }

    async getLatestPending(since?: Date) {
        const windowStart = since ?? new Date(Date.now() - 15 * 60 * 1000);
        try {
            return await prisma.pendingCardScan.findFirst({
                where: {
                    registered: false,
                    scannedAt: { gte: windowStart },
                },
                orderBy: { scannedAt: "desc" },
            });
        } catch {
            return null;
        }
    }
}

export const cardRegistrationService = new CardRegistrationService();

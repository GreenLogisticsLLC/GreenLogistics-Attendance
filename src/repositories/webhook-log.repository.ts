import { prisma } from "../config/database.js";

export class WebhookLogRepository {
    async findByWebhookId(webhookId: string) {
        return prisma.webhookLog.findFirst({
            where: { webhookId, processingStatus: "SUCCESS" },
            orderBy: { requestTime: "desc" },
        });
    }

    async create(data: {
        webhookId: string;
        employeeIdentifier?: string;
        requestPayload: string;
        responseCode: number;
        processingStatus: string;
        processingTimeMs: number;
        errorMessage?: string;
    }) {
        return prisma.webhookLog.create({ data });
    }

    async findRecent(limit = 50) {
        return prisma.webhookLog.findMany({
            orderBy: { requestTime: "desc" },
            take: limit,
        });
    }
}

export const webhookLogRepository = new WebhookLogRepository();

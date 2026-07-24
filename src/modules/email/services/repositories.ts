import { prisma } from "../../../config/database.js";
import type { ImportLogEventType } from "../models/types.js";

export class EmailMessageRepository {
    findByGmailId(gmailMessageId: string) {
        return prisma.emailMessage.findUnique({ where: { gmailMessageId } });
    }

    create(data: {
        gmailMessageId: string;
        gmailThreadId?: string;
        fromAddress: string;
        subject: string;
        snippet?: string;
        receivedAt: Date;
        processStatus?: string;
        source?: string;
        rawHeaders?: string;
        bodyText?: string;
        bodyHtml?: string;
    }) {
        return prisma.emailMessage.create({ data });
    }

    markProcessed(emailMessageId: string, processStatus: string, source?: string) {
        return prisma.emailMessage.update({
            where: { emailMessageId },
            data: {
                processStatus,
                processedAt: new Date(),
                source: source || undefined,
            },
        });
    }
}

export class ShipmentLeadRepository {
    findByViewUrl(viewUrl: string) {
        return prisma.shipmentLead.findUnique({ where: { viewUrl } });
    }

    findByExternalId(source: string, externalShipmentId: string) {
        return prisma.shipmentLead.findFirst({
            where: { source, externalShipmentId },
        });
    }

    findById(shipmentLeadId: string) {
        return prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
            include: { emailMessage: true, importLogs: { orderBy: { createdAt: "desc" }, take: 50 } },
        });
    }

    list(limit = 100) {
        return prisma.shipmentLead.findMany({
            orderBy: { createdAt: "desc" },
            take: limit,
            include: { emailMessage: true },
        });
    }

    create(data: Parameters<typeof prisma.shipmentLead.create>[0]["data"]) {
        return prisma.shipmentLead.create({ data });
    }

    update(shipmentLeadId: string, data: Parameters<typeof prisma.shipmentLead.update>[0]["data"]) {
        return prisma.shipmentLead.update({ where: { shipmentLeadId }, data });
    }
}

export class ShipmentImportLogRepository {
    create(data: {
        eventType: ImportLogEventType | string;
        message: string;
        gmailMessageId?: string;
        emailMessageId?: string;
        shipmentLeadId?: string;
        metaJson?: string;
    }) {
        return prisma.shipmentImportLog.create({ data });
    }

    list(limit = 200) {
        return prisma.shipmentImportLog.findMany({
            orderBy: { createdAt: "desc" },
            take: limit,
        });
    }
}

export const emailMessageRepository = new EmailMessageRepository();
export const shipmentLeadRepository = new ShipmentLeadRepository();
export const shipmentImportLogRepository = new ShipmentImportLogRepository();

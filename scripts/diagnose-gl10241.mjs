/**
 * Diagnose a ghost / incomplete Accounting load (default GL10241).
 *   node scripts/diagnose-gl10241.mjs GL10241
 *
 * Prints provenance: broker, GOS id, rates, docs, domain events, audit, siblings.
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const loadNumber = String(process.argv[2] || "GL10241").trim().toUpperCase();

function money(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    return Number(n);
}

async function userLabel(userId) {
    if (!userId) return null;
    const u = await prisma.user.findUnique({
        where: { userId },
        select: { userId: true, firstName: true, lastName: true, username: true, email: true, role: true },
    });
    if (!u) return { userId, missing: true };
    return {
        userId: u.userId,
        name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.username || u.email,
        role: u.role,
        email: u.email,
    };
}

async function main() {
    console.log("=== diagnose load", loadNumber, "===");
    const lead = await prisma.shipmentLead.findFirst({
        where: { loadNumber },
        include: {
            emailMessage: {
                select: {
                    subject: true,
                    snippet: true,
                    fromAddress: true,
                    receivedAt: true,
                    gmailMessageId: true,
                },
            },
            loadDocuments: {
                where: { isCurrent: true, status: { not: "ARCHIVED" } },
                select: {
                    documentId: true,
                    docType: true,
                    status: true,
                    fileName: true,
                    createdAt: true,
                    createdById: true,
                },
                orderBy: { createdAt: "asc" },
            },
        },
    });
    if (!lead) {
        console.log("NOT FOUND by loadNumber");
        const soft = await prisma.shipmentLead.findMany({
            where: {
                OR: [
                    { loadNumber: { contains: "10241" } },
                    { customerName: { contains: "Sanabria" } },
                    { carrierName: { contains: "BOX BOYS" } },
                ],
            },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                status: true,
                customerName: true,
                carrierName: true,
                assignedBrokerId: true,
                customerRate: true,
                carrierRate: true,
                createdAt: true,
            },
            take: 20,
        });
        console.log("soft matches", soft);
        return;
    }

    const broker = await userLabel(lead.assignedBrokerId);
    console.log(
        JSON.stringify(
            {
                shipmentLeadId: lead.shipmentLeadId,
                loadNumber: lead.loadNumber,
                greenOsShipmentId: lead.greenOsShipmentId,
                externalShipmentId: lead.externalShipmentId,
                source: lead.source,
                status: lead.status,
                shipmentTitle: lead.shipmentTitle,
                customerName: lead.customerName,
                customerEmail: lead.customerEmail,
                customerPhone: lead.customerPhone,
                customerRate: money(lead.customerRate),
                price: money(lead.price),
                carrierName: lead.carrierName,
                carrierRate: money(lead.carrierRate),
                carrierProfileId: lead.carrierProfileId,
                assignedBrokerId: lead.assignedBrokerId,
                broker,
                pickup: [lead.pickupCity, lead.pickupState, lead.pickupZip].filter(Boolean).join(", "),
                delivery: [lead.deliveryCity, lead.deliveryState, lead.deliveryZip]
                    .filter(Boolean)
                    .join(", "),
                pickupFrom: lead.pickupFrom,
                deliveryFrom: lead.deliveryFrom,
                opsPickupAt: lead.opsPickupAt,
                opsDeliveryAt: lead.opsDeliveryAt,
                acceptedAt: lead.acceptedAt,
                createdAt: lead.createdAt,
                updatedAt: lead.updatedAt,
                viewUrl: lead.viewUrl,
                accountingDocStatus: lead.accountingDocStatus,
                accountingFinancialVerified: lead.accountingFinancialVerified,
                accountingReadyForBilling: lead.accountingReadyForBilling,
                accountingReadyForCarrierPayment: lead.accountingReadyForCarrierPayment,
                customerPaidAt: lead.customerPaidAt,
                carrierPaidAt: lead.carrierPaidAt,
                accountingClosedAt: lead.accountingClosedAt,
                invoiceNumber: lead.invoiceNumber,
                paymentStatus: lead.paymentStatus,
                emailSubject: lead.emailMessage?.subject || null,
                emailFrom: lead.emailMessage?.fromAddress || null,
                emailReceivedAt: lead.emailMessage?.receivedAt || null,
                emailSnippet: (lead.emailMessage?.snippet || "").slice(0, 400),
            },
            null,
            2
        )
    );

    console.log("\n--- load documents ---", lead.loadDocuments.length);
    for (const d of lead.loadDocuments) {
        const by = await userLabel(d.createdById);
        console.log({
            docType: d.docType,
            status: d.status,
            fileName: d.fileName,
            createdAt: d.createdAt,
            by: by?.name || d.createdById,
        });
    }

    let events = [];
    try {
        events = await prisma.domainEvent.findMany({
            where: { shipmentLeadId: lead.shipmentLeadId },
            orderBy: { createdAt: "asc" },
            take: 80,
            select: {
                eventType: true,
                title: true,
                message: true,
                actorUserId: true,
                createdAt: true,
                payloadJson: true,
            },
        });
    } catch (e) {
        console.log("domainEvent query failed", e.message);
    }
    console.log("\n--- domain events ---", events.length);
    for (const e of events) {
        const actor = await userLabel(e.actorUserId);
        console.log({
            at: e.createdAt,
            type: e.eventType,
            title: e.title,
            message: (e.message || "").slice(0, 200),
            actor: actor?.name || e.actorUserId,
            payload: (e.payloadJson || "").slice(0, 160),
        });
    }

    let audits = [];
    try {
        audits = await prisma.auditLog.findMany({
            where: {
                OR: [
                    { entityId: lead.shipmentLeadId },
                    ...(lead.loadNumber ? [{ entityId: lead.loadNumber }] : []),
                ],
            },
            orderBy: { createdAt: "asc" },
            take: 80,
            select: {
                action: true,
                module: true,
                userId: true,
                createdAt: true,
                oldValue: true,
                newValue: true,
            },
        });
    } catch (e) {
        console.log("auditLog query failed", e.message);
    }
    console.log("\n--- audit ---", audits.length);
    for (const a of audits) {
        const actor = await userLabel(a.userId);
        console.log({
            at: a.createdAt,
            module: a.module,
            action: a.action,
            actor: actor?.name || a.userId,
            old: (a.oldValue || "").slice(0, 120),
            new: (a.newValue || "").slice(0, 120),
        });
    }

    // Sibling loads: same customer/carrier or same GOS/external id without this loadNumber.
    const siblings = await prisma.shipmentLead.findMany({
        where: {
            shipmentLeadId: { not: lead.shipmentLeadId },
            OR: [
                lead.greenOsShipmentId
                    ? { greenOsShipmentId: lead.greenOsShipmentId }
                    : undefined,
                lead.externalShipmentId
                    ? { externalShipmentId: lead.externalShipmentId }
                    : undefined,
                lead.customerName
                    ? { customerName: { equals: lead.customerName } }
                    : undefined,
                lead.carrierName
                    ? { carrierName: { contains: String(lead.carrierName).slice(0, 20) } }
                    : undefined,
            ].filter(Boolean),
        },
        select: {
            shipmentLeadId: true,
            loadNumber: true,
            greenOsShipmentId: true,
            status: true,
            customerName: true,
            carrierName: true,
            customerRate: true,
            carrierRate: true,
            assignedBrokerId: true,
            createdAt: true,
        },
        take: 30,
        orderBy: { createdAt: "desc" },
    });
    console.log("\n--- sibling candidates ---", siblings.length);
    for (const s of siblings) {
        const b = await userLabel(s.assignedBrokerId);
        console.log({
            ...s,
            broker: b?.name || null,
        });
    }

    // Ghost pattern sample: GL# present, customer rate empty/0, carrier rate > 0
    const ghosts = await prisma.shipmentLead.findMany({
        where: {
            loadNumber: { not: null },
            OR: [{ customerRate: null }, { customerRate: 0 }],
            carrierRate: { gt: 0 },
            status: { not: "VOIDED" },
        },
        select: {
            loadNumber: true,
            status: true,
            customerName: true,
            carrierName: true,
            customerRate: true,
            carrierRate: true,
            assignedBrokerId: true,
            createdAt: true,
        },
        take: 40,
        orderBy: { createdAt: "desc" },
    });
    console.log("\n--- ghost pattern (custRate null/0, carrRate>0) ---", ghosts.length);
    for (const g of ghosts) {
        const b = await userLabel(g.assignedBrokerId);
        console.log({
            loadNumber: g.loadNumber,
            status: g.status,
            customer: g.customerName,
            carrier: g.carrierName,
            customerRate: g.customerRate,
            carrierRate: g.carrierRate,
            broker: b?.name || null,
            createdAt: g.createdAt,
        });
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

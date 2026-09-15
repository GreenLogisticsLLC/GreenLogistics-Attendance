/**
 * Diagnose false "Customer Replied" for a shipment (e.g. GOS1000030).
 *   node scripts/diagnose-customer-replied.mjs GOS1000030
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const query = (process.argv[2] || "GOS1000030").trim();

async function main() {
  console.log("=== DIAGNOSE CUSTOMER REPLIED ===", query);

  const lead = await prisma.shipmentLead.findFirst({
    where: {
      OR: [
        { greenOsShipmentId: query },
        { shipmentLeadId: query },
        { shipmentTitle: { contains: query } },
      ],
    },
  });
  if (!lead) {
    console.log("NOT_FOUND");
    return;
  }

  console.log({
    shipmentLeadId: lead.shipmentLeadId,
    greenOsShipmentId: lead.greenOsShipmentId,
    status: lead.status,
    brokerReplyDeadline: lead.brokerReplyDeadline,
    assignedBrokerId: lead.assignedBrokerId,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    customerRepliedFlag:
      String(lead.status || "") === "CUSTOMER_REPLIED" || Boolean(lead.brokerReplyDeadline),
  });

  const events = await prisma.domainEvent.findMany({
    where: { shipmentLeadId: lead.shipmentLeadId },
    orderBy: { createdAt: "asc" },
    select: {
      eventId: true,
      eventType: true,
      title: true,
      message: true,
      payloadJson: true,
      timelineStage: true,
      createdAt: true,
    },
  });
  console.log("DOMAIN_EVENTS", events.length);
  for (const e of events) {
    console.log({
      at: e.createdAt,
      type: e.eventType,
      stage: e.timelineStage,
      title: e.title,
      message: (e.message || "").slice(0, 180),
      payload: (e.payloadJson || "").slice(0, 280),
    });
  }

  const qaTypes = [
    "CUSTOMER_RESPOND",
    "CUSTOMER_REPLIED",
    "CUSTOMER_QUESTION",
    "NEW_MESSAGE",
    "BROKER_QUESTION",
    "BROKER_ANSWER",
  ];
  console.log(
    "QA_EVENTS",
    events
      .filter((e) => qaTypes.includes(e.eventType))
      .map((e) => ({ type: e.eventType, at: e.createdAt, title: e.title }))
  );

  const mailbox = await prisma.brokerMailboxMessage.findMany({
    where: {
      OR: [
        { shipmentLeadId: lead.shipmentLeadId },
        ...(lead.greenOsShipmentId
          ? [{ subject: { contains: lead.greenOsShipmentId } }]
          : []),
      ],
    },
    orderBy: { receivedAt: "desc" },
    take: 30,
    select: {
      gmailMessageId: true,
      subject: true,
      fromAddress: true,
      receivedAt: true,
      shipmentLeadId: true,
      matchMethod: true,
    },
  });
  console.log("MAILBOX", mailbox);

  console.log("=== END ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * Repair false CUSTOMER_REPLIED when there is no real customer Q&A evidence.
 *   node scripts/ops-fix-false-customer-replied.mjs --confirm=FIX_FALSE_CUSTOMER_REPLIED
 *   node scripts/ops-fix-false-customer-replied.mjs --confirm=FIX_FALSE_CUSTOMER_REPLIED GOS1000030
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CONFIRM = "FIX_FALSE_CUSTOMER_REPLIED";
const args = process.argv.slice(2);
const confirmed = args.includes(`--confirm=${CONFIRM}`);
const onlyId = args.find((a) => !a.startsWith("--")) || null;

const QA_TYPES = [
  "CUSTOMER_RESPOND",
  "CUSTOMER_REPLIED",
  "CUSTOMER_QUESTION",
  "NEW_MESSAGE",
];

function isInstantAlertSubject(subject) {
  const s = String(subject || "").toLowerCase();
  return (
    /\binstant\s+alert\b/.test(s) ||
    /\bmatches\s+your\b.{0,40}\bsaved\s+search\b/.test(s) ||
    /^new\s+shipment\b/.test(s.trim())
  );
}

async function main() {
  if (!confirmed) {
    console.error("Refusing to run without --confirm=" + CONFIRM);
    process.exitCode = 1;
    return;
  }

  const where = {
    status: "CUSTOMER_REPLIED",
    ...(onlyId
      ? {
          OR: [{ greenOsShipmentId: onlyId }, { shipmentLeadId: onlyId }],
        }
      : {}),
  };

  const leads = await prisma.shipmentLead.findMany({ where });
  console.log("CANDIDATES", leads.length);

  let fixed = 0;
  for (const lead of leads) {
    const events = await prisma.domainEvent.findMany({
      where: {
        shipmentLeadId: lead.shipmentLeadId,
        eventType: { in: QA_TYPES },
      },
      orderBy: { createdAt: "desc" },
    });

    const realQa = events.filter((e) => {
      let payload = {};
      try {
        payload = e.payloadJson ? JSON.parse(e.payloadJson) : {};
      } catch {
        payload = {};
      }
      const subject = String(e.message || e.title || "");
      if (isInstantAlertSubject(subject)) return false;
      // Keep if Gmail-backed or clearly titled Customer Respond/Question.
      if (payload.gmailMessageId) return true;
      if (/customer\s+respond|customer\s+question|question\s+answered/i.test(subject)) {
        return true;
      }
      if (/customer\s+respond|customer\s+question|question\s+answered/i.test(e.title || "")) {
        return true;
      }
      return false;
    });

    if (realQa.length) {
      console.log("KEEP", lead.greenOsShipmentId, "realQa", realQa.length);
      continue;
    }

    // Prefer BID_SUBMITTED if a bid event exists, else WORKING (Shipment Accepted).
    const bid = await prisma.domainEvent.findFirst({
      where: {
        shipmentLeadId: lead.shipmentLeadId,
        eventType: { in: ["BID_SUBMITTED", "QUOTE_SUBMITTED"] },
      },
    });
    const nextStatus = bid ? "BID_SUBMITTED" : "WORKING";

    await prisma.shipmentLead.update({
      where: { shipmentLeadId: lead.shipmentLeadId },
      data: {
        status: nextStatus,
        brokerReplyDeadline: null,
      },
    });

    // Soft-delete false QA events that lack real Gmail (keep audit via payload if needed).
    for (const e of events) {
      let payload = {};
      try {
        payload = e.payloadJson ? JSON.parse(e.payloadJson) : {};
      } catch {
        payload = {};
      }
      if (payload.gmailMessageId && !isInstantAlertSubject(e.message || "")) continue;
      await prisma.domainEvent.delete({ where: { eventId: e.eventId } }).catch(() => null);
    }

    console.log("FIXED", lead.greenOsShipmentId || lead.shipmentLeadId, "->", nextStatus, {
      droppedQaEvents: events.length,
    });
    fixed += 1;
  }

  console.log("DONE fixed=", fixed);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

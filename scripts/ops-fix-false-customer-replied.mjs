/**
 * Repair false CUSTOMER_REPLIED when Q&A Gmail is older than the shipment card
 * (soft title rematch like "1 Pallet") or there is no real post-create Q&A.
 *
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
const SKEW_MS = 2 * 60_000;

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

async function mailReceivedAt(gmailMessageId) {
  if (!gmailMessageId) return null;
  const broker = await prisma.brokerMailboxMessage.findFirst({
    where: { gmailMessageId },
    select: { receivedAt: true },
  });
  if (broker?.receivedAt) return broker.receivedAt;
  const company = await prisma.emailMessage
    .findFirst({
      where: { gmailMessageId },
      select: { receivedAt: true },
    })
    .catch(() => null);
  return company?.receivedAt || null;
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

    const realQa = [];
    const staleQa = [];
    for (const e of events) {
      let payload = {};
      try {
        payload = e.payloadJson ? JSON.parse(e.payloadJson) : {};
      } catch {
        payload = {};
      }
      const subject = String(e.message || e.title || "");
      if (isInstantAlertSubject(subject)) {
        staleQa.push(e);
        continue;
      }
      // Transition-only audit rows (no Gmail) are not evidence of a customer reply.
      if (!payload.gmailMessageId) {
        staleQa.push(e);
        continue;
      }
      const receivedAt = await mailReceivedAt(payload.gmailMessageId);
      if (
        receivedAt &&
        lead.createdAt &&
        receivedAt.getTime() + SKEW_MS < new Date(lead.createdAt).getTime()
      ) {
        console.log("STALE_QA", lead.greenOsShipmentId, {
          gmailMessageId: payload.gmailMessageId,
          receivedAt,
          shipmentCreatedAt: lead.createdAt,
          subject: subject.slice(0, 80),
        });
        staleQa.push(e);
        continue;
      }
      realQa.push(e);
    }

    if (realQa.length) {
      console.log("KEEP", lead.greenOsShipmentId, "realQa", realQa.length);
      continue;
    }

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

    for (const e of staleQa) {
      await prisma.domainEvent.delete({ where: { eventId: e.eventId } }).catch(() => null);
    }

    console.log("FIXED", lead.greenOsShipmentId || lead.shipmentLeadId, "->", nextStatus, {
      droppedQaEvents: staleQa.length,
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

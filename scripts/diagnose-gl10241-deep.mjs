import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const id = "e2b109d0-b302-4002-8664-dca619b8c9dc";

async function main() {
  const events = await prisma.domainEvent.findMany({
    where: {
      shipmentLeadId: id,
      NOT: { eventType: "CUSTOMER_ACCEPTED" },
    },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { eventType: true, title: true, message: true, actorUserId: true, createdAt: true, payloadJson: true },
  });
  console.log("--- non-CUSTOMER_ACCEPTED events ---", events.length);
  for (const e of events) {
    console.log({
      at: e.createdAt,
      type: e.eventType,
      title: e.title,
      message: (e.message || "").slice(0, 220),
      payload: (e.payloadJson || "").slice(0, 240),
    });
  }

  let assignments = [];
  try {
    assignments = await prisma.loadCarrierAssignment.findMany({
      where: { shipmentLeadId: id },
      orderBy: { createdAt: "asc" },
    });
  } catch (e) {
    console.log("loadCarrierAssignment fail", e.message);
  }
  console.log("--- assignments ---", assignments.length);
  for (const a of assignments) console.log(a);

  let settlements = [];
  try {
    settlements = await prisma.previousCarrierSettlement.findMany({
      where: { OR: [{ shipmentLeadId: id }, { loadNumber: "GL10241" }] },
    });
  } catch (e) {
    console.log("settlement fail", e.message);
  }
  console.log("--- settlements ---", settlements.length);
  for (const s of settlements) console.log(s);

  // Compare GL10240 / GL10239 key fields
  for (const ln of ["GL10239", "GL10240", "GL10241"]) {
    const s = await prisma.shipmentLead.findFirst({
      where: { loadNumber: ln },
      select: {
        loadNumber: true,
        status: true,
        greenOsShipmentId: true,
        customerName: true,
        carrierName: true,
        customerRate: true,
        carrierRate: true,
        carrierProfileId: true,
        assignedBrokerId: true,
        updatedAt: true,
        viewUrl: true,
      },
    });
    console.log("--- compare", ln, "---", s);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

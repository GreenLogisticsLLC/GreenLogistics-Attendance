/**
 * Contabo / local helper: simulate Customer Accepted + Create Load for Kate Williams.
 *
 * Usage on VPS:
 *   cd /root/GreenLogistics-Attendance
 *   node scripts/test-customer-accept-kate.mjs
 *   node scripts/test-customer-accept-kate.mjs --shipment <shipmentLeadId>
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function findKate() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { firstName: { contains: "Kate" } },
        { lastName: { contains: "Williams" } },
        { username: { contains: "kate" } },
        { email: { contains: "kate" } },
      ],
    },
    select: {
      userId: true,
      username: true,
      firstName: true,
      lastName: true,
      email: true,
      role: { select: { roleName: true } },
    },
  });
  return users[0] || null;
}

async function pickShipment(brokerId, forcedId) {
  if (forcedId) {
    return prisma.shipmentLead.findUnique({ where: { shipmentLeadId: forcedId } });
  }
  // Prefer active pre-accept work assigned to Kate.
  const preferred = await prisma.shipmentLead.findFirst({
    where: {
      assignedBrokerId: brokerId,
      loadNumber: null,
      status: {
        in: [
          "WORKING",
          "BID_SUBMITTED",
          "CUSTOMER_REPLIED",
          "FOLLOW_UP",
          "AGENT_OPEN",
          "AWAITING_ACCEPTANCE",
          "ASSIGNED",
        ],
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (preferred) return preferred;
  return prisma.shipmentLead.findFirst({
    where: { assignedBrokerId: brokerId, loadNumber: null },
    orderBy: { updatedAt: "desc" },
  });
}

async function main() {
  const kate = await findKate();
  if (!kate) {
    console.error("Kate Williams not found in this database.");
    process.exit(1);
  }
  console.log(
    `Broker: ${kate.firstName} ${kate.lastName} (${kate.username}) [${kate.role?.roleName}]`
  );

  const shipment = await pickShipment(kate.userId, arg("--shipment"));
  if (!shipment) {
    console.error("No suitable shipment for Kate (need assigned card without Load #).");
    process.exit(1);
  }

  console.log(
    `Shipment: ${shipment.greenOsShipmentId || shipment.shipmentLeadId} | ${shipment.shipmentTitle} | status=${shipment.status}`
  );

  // Dynamic import compiled or ts path — run after build via dist, or use prisma-only path here.
  // This script only prepares DB status; full domain events need the app service.
  // Prefer calling the HTTP API if GREENOS_URL + TOKEN set.
  const base = process.env.GREENOS_URL || process.env.PUBLIC_APP_URL || "";
  const token = process.env.GREENOS_TOKEN || "";
  if (base && token) {
    const url = `${base.replace(/\/$/, "")}/api/crm/shipments/${shipment.shipmentLeadId}/test-customer-accept`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const json = await res.json().catch(() => ({}));
    console.log(res.status, JSON.stringify(json, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  console.log(`
No GREENOS_URL/GREENOS_TOKEN — open this shipment in UI as Kate (or Owner) and click:
  TEST: Customer Accepted → Create Load

shipmentLeadId=${shipment.shipmentLeadId}
greenOsShipmentId=${shipment.greenOsShipmentId || "—"}
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

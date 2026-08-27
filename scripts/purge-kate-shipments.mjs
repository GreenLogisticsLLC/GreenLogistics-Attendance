/**
 * Purge shipments assigned to Kate Williams (keeps user + Gmail; new mail still imports).
 *
 * Dry-run (default):
 *   node scripts/purge-kate-shipments.mjs
 *
 * Execute:
 *   node scripts/purge-kate-shipments.mjs --execute
 *
 * Options:
 *   --keep-loads   do not delete shipments that already have a Load Number
 *   --broker <id>  override userId
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const execute = process.argv.includes("--execute");
const keepLoads = process.argv.includes("--keep-loads");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function findKate(forcedId) {
  if (forcedId) {
    return prisma.user.findUnique({
      where: { userId: forcedId },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        email: true,
        role: { select: { roleName: true } },
      },
    });
  }
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
  if (users.length > 1) {
    console.log("Multiple Kate matches:");
    for (const u of users) {
      console.log(`  ${u.userId}  ${u.firstName} ${u.lastName}  ${u.username}  ${u.role?.roleName}`);
    }
  }
  return users[0] || null;
}

async function main() {
  const kate = await findKate(arg("--broker"));
  if (!kate) {
    console.error("Kate Williams not found.");
    process.exit(1);
  }
  console.log(
    `Broker: ${kate.firstName} ${kate.lastName} (${kate.username}) [${kate.role?.roleName}] ${kate.userId}`
  );

  const where = {
    assignedBrokerId: kate.userId,
    ...(keepLoads ? { loadNumber: null } : {}),
  };

  const total = await prisma.shipmentLead.count({ where });
  const withLoad = await prisma.shipmentLead.count({
    where: { assignedBrokerId: kate.userId, loadNumber: { not: null } },
  });
  const byStatus = await prisma.shipmentLead.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  console.log(`Matching shipments to purge: ${total}`);
  console.log(`Kate shipments with Load #: ${withLoad}`);
  console.log(
    "By status:",
    byStatus
      .map((r) => `${r.status}=${r._count._all}`)
      .sort()
      .join(", ") || "(none)"
  );

  if (!execute) {
    console.log("Dry-run only. Re-run with --execute to delete.");
    return;
  }

  if (total === 0) {
    console.log("Nothing to delete.");
    return;
  }

  const ids = (
    await prisma.shipmentLead.findMany({
      where,
      select: { shipmentLeadId: true },
    })
  ).map((r) => r.shipmentLeadId);

  // Delete related rows first where cascades may be incomplete / SQLite FK quirks.
  const chunk = 200;
  let deletedChildren = 0;
  for (let i = 0; i < ids.length; i += chunk) {
    const batch = ids.slice(i, i + chunk);
    const tables = [
      "shipment_import_logs",
      "shipment_timeline_events",
      "broker_mailbox_messages",
      "platform_notifications",
      "domain_events",
      "load_documents",
      "shipment_trackings",
      "ai_actions",
    ];
    for (const table of tables) {
      try {
        const n = await prisma.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE shipment_lead_id IN (${batch.map(() => "?").join(",")})`,
          ...batch
        );
        deletedChildren += Number(n || 0);
      } catch {
        /* table may not exist / no FK column */
      }
    }
  }

  const deletedLeads = await prisma.shipmentLead.deleteMany({ where });
  console.log(
    `Deleted shipment_leads=${deletedLeads.count}; related rows touched≈${deletedChildren}`
  );
  console.log("Kate user + Gmail kept. New uShip emails will still create shipments.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

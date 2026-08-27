/**
 * Mark all active Brokers as In Office for the current attendance day,
 * join the assignment queue, then drain parked UNASSIGNED leads.
 *
 * Contabo:
 *   node scripts/mark-brokers-in-office.mjs
 *   node scripts/mark-brokers-in-office.mjs --drain=100
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}

async function loadDist() {
  const root = process.cwd();
  const attendanceUrl = pathToFileURL(
    path.join(root, "dist/services/attendance.service.js")
  ).href;
  const assignUrl = pathToFileURL(
    path.join(root, "dist/modules/assignment/assignment.engine.js")
  ).href;
  const presenceUrl = pathToFileURL(
    path.join(root, "dist/services/attendance-presence.service.js")
  ).href;
  const [{ attendanceService }, { assignmentEngine }, { isEmployeeInOffice }] =
    await Promise.all([
      import(attendanceUrl),
      import(assignUrl),
      import(presenceUrl),
    ]);
  return { attendanceService, assignmentEngine, isEmployeeInOffice };
}

async function main() {
  const drainLimit = argNum("--drain", 100);
  const { attendanceService, assignmentEngine, isEmployeeInOffice } =
    await loadDist();

  const brokers = await prisma.user.findMany({
    where: { role: { roleName: "Broker" }, isActive: true },
    include: { employee: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const marked = [];
  const skipped = [];

  for (const b of brokers) {
    const empId = b.employeeId || b.employee?.employeeId;
    const name = `${b.firstName} ${b.lastName}`.trim() || b.username;
    if (!empId) {
      skipped.push({ name, reason: "no employeeId" });
      continue;
    }
    if (await isEmployeeInOffice(empId)) {
      skipped.push({ name, reason: "already In Office" });
      continue;
    }

    const now = new Date();
    const webhookId = `ops-mark-in|${empId}|${now.toISOString()}|enter`;
    const result = await attendanceService.processEvent({
      employeeId: empId,
      eventTime: now,
      direction: "ENTRY",
      deviceId: "ops-mark-in-office",
      webhookId,
      source: "OPS_MARK_IN_OFFICE",
    });
    marked.push({
      name,
      status: result.session?.currentStatus,
      duplicate: Boolean(result.duplicate),
    });
  }

  console.log("=== MARKED IN OFFICE ===", marked.length);
  for (const row of marked) console.log(row);
  console.log("=== SKIPPED ===", skipped.length);
  for (const row of skipped) console.log(row);

  const eligible = await assignmentEngine.listEligibleBrokers();
  console.log(
    "=== ELIGIBLE ===",
    eligible.length,
    eligible.map((e) => e.displayName)
  );

  await assignmentEngine.processDueAcceptances();
  const drained = await assignmentEngine.assignPendingNewLeads(drainLimit);
  console.log("DRAINED", drained);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

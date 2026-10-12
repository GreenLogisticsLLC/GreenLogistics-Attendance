/**
 * Ops: ensure In Office brokers (esp. Lia) receive parked shipments.
 *   node scripts/ops-fix-in-office-assign.mjs --confirm=FIX_IN_OFFICE_ASSIGN
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CONFIRM = "FIX_IN_OFFICE_ASSIGN";

async function main() {
  if (!process.argv.includes(`--confirm=${CONFIRM}`)) {
    console.error("Refusing without --confirm=" + CONFIRM);
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const [
    { attendanceService },
    { assignmentEngine },
    { isEmployeeInOffice },
    { backfillMissingAttendanceBadges },
  ] = await Promise.all([
    import(pathToFileURL(path.join(root, "dist/services/attendance.service.js")).href),
    import(pathToFileURL(path.join(root, "dist/modules/assignment/assignment.engine.js")).href),
    import(pathToFileURL(path.join(root, "dist/services/attendance-presence.service.js")).href),
    import(pathToFileURL(path.join(root, "dist/services/user-attendance-link.service.js")).href),
  ]);

  console.log("=== FIX IN OFFICE ASSIGN ===");
  const badges = await backfillMissingAttendanceBadges().catch((e) => {
    console.warn("badge backfill failed", e?.message || e);
    return null;
  });
  console.log("BADGES", badges);

  // Run diagnose first
  const { spawnSync } = await import("child_process");
  spawnSync("node", ["scripts/diagnose-in-office-assign.mjs"], {
    cwd: root,
    stdio: "inherit",
  });

  const brokers = await prisma.user.findMany({
    where: { role: { roleName: "Broker" }, isActive: true },
    include: { employee: true },
  });

  const lia = brokers.find((b) => {
    const n = `${b.firstName} ${b.lastName}`.trim().toLowerCase();
    return n === "lia torres" || (n.startsWith("lia ") && n.includes("torres"));
  });
  if (lia) {
    const empId = lia.employeeId || lia.employee?.employeeId;
    console.log("LIA_USER", `${lia.firstName} ${lia.lastName}`, empId);
    if (empId && !(await isEmployeeInOffice(empId))) {
      const now = new Date();
      console.log("LIA_CHECKIN …");
      await attendanceService.processEvent({
        employeeId: empId,
        eventTime: now,
        direction: "ENTRY",
        deviceId: "ops-fix-in-office-assign",
        webhookId: `ops-lia-in|${empId}|${now.toISOString()}|enter`,
        source: "OPS_FIX_IN_OFFICE_ASSIGN",
      });
      await assignmentEngine.onBrokerEnteredOffice(empId).catch(() => null);
      console.log("LIA_IN_OFFICE_AFTER", await isEmployeeInOffice(empId));
    } else {
      console.log("LIA_ALREADY_IN_OFFICE", empId ? await isEmployeeInOffice(empId) : false);
      if (empId) await assignmentEngine.onBrokerEnteredOffice(empId).catch(() => null);
    }
  } else {
    console.log("LIA_NOT_FOUND");
  }

  await assignmentEngine.processDueAcceptances().catch((e) =>
    console.warn("processDueAcceptances", e?.message || e)
  );
  const drained = await assignmentEngine.assignPendingNewLeads(100, {
    includeOther: true,
  });
  const eligible = await assignmentEngine.listEligibleBrokers();
  const queue = await assignmentEngine.getQueueStatus();

  console.log("DRAINED", drained);
  console.log(
    "ELIGIBLE_AFTER",
    eligible.map((e) => e.displayName)
  );
  console.log("QUEUE", {
    mode: queue.assignmentMode,
    nextBroker: queue.nextBroker,
    eligible: queue.eligible,
  });

  spawnSync("node", ["scripts/diagnose-in-office-assign.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("=== END FIX ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

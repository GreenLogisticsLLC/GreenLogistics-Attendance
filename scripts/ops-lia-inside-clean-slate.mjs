/**
 * Ops: put ONLY Lia Torres In Office, mark other brokers Out, wipe all shipments.
 *
 * Contabo:
 *   node scripts/ops-lia-inside-clean-slate.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function nameOf(u) {
  return `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.username;
}

function isLia(u) {
  return /lia/i.test(u.firstName || "") && /torres/i.test(u.lastName || "");
}

async function loadDist() {
  const root = process.cwd();
  const [
    { attendanceService },
    { assignmentEngine },
    { isEmployeeInOffice, getInOfficeEmployeeIds },
    { assignmentOpsService },
  ] = await Promise.all([
    import(pathToFileURL(path.join(root, "dist/services/attendance.service.js")).href),
    import(
      pathToFileURL(path.join(root, "dist/modules/assignment/assignment.engine.js")).href
    ),
    import(
      pathToFileURL(path.join(root, "dist/services/attendance-presence.service.js")).href
    ),
    import(
      pathToFileURL(
        path.join(root, "dist/modules/assignment/services/assignment-ops.service.js")
      ).href
    ),
  ]);
  return {
    attendanceService,
    assignmentEngine,
    isEmployeeInOffice,
    getInOfficeEmployeeIds,
    assignmentOpsService,
  };
}

async function forceInside(attendanceService, assignmentEngine, empId, label) {
  const now = new Date();
  // EXIT first if already INSIDE so a fresh ENTRY updates presence/activity.
  const before = await prisma.attendanceSession.findFirst({
    where: { employeeId: empId },
    orderBy: { updatedAt: "desc" },
  });
  if (before?.currentStatus === "INSIDE_OFFICE") {
    await attendanceService
      .processEvent({
        employeeId: empId,
        eventTime: new Date(now.getTime() - 1000),
        direction: "EXIT",
        deviceId: "ops-lia-clean-slate",
        webhookId: `ops-lia-clean|${empId}|${now.toISOString()}|exit`,
        source: "OPS_LIA_CLEAN_SLATE",
      })
      .catch(() => null);
  }

  const enter = await attendanceService.processEvent({
    employeeId: empId,
    eventTime: now,
    direction: "ENTRY",
    deviceId: "ops-lia-clean-slate",
    webhookId: `ops-lia-clean|${empId}|${now.toISOString()}|enter`,
    source: "OPS_LIA_CLEAN_SLATE",
  });

  // Ensure session looks freshly active for assignment shift-window gate.
  if (enter?.session?.sessionId) {
    await prisma.attendanceSession.update({
      where: { sessionId: enter.session.sessionId },
      data: {
        currentStatus: "INSIDE_OFFICE",
        firstEntry: now,
        lastActivity: now,
        updatedAt: now,
      },
    });
  }
  await assignmentEngine.onBrokerEnteredOffice(empId).catch(() => null);
  console.log("FORCE_INSIDE", label, {
    status: enter?.session?.currentStatus || "INSIDE_OFFICE",
    duplicate: Boolean(enter?.duplicate),
  });
}

async function forceOutside(attendanceService, assignmentEngine, empId, label) {
  const now = new Date();
  const session = await prisma.attendanceSession.findFirst({
    where: { employeeId: empId },
    orderBy: { updatedAt: "desc" },
  });
  if (session && session.currentStatus === "INSIDE_OFFICE") {
    // Only call EXIT when truly inside — processEvent flips EXIT→ENTRY otherwise.
    await attendanceService
      .processEvent({
        employeeId: empId,
        eventTime: now,
        direction: "EXIT",
        deviceId: "ops-lia-clean-slate",
        webhookId: `ops-lia-clean|${empId}|${now.toISOString()}|exit-others`,
        source: "OPS_LIA_CLEAN_SLATE",
      })
      .catch(() => null);
  } else if (session && session.currentStatus !== "OUTSIDE_OFFICE" && session.currentStatus !== "COMPLETED") {
    await prisma.attendanceSession.update({
      where: { sessionId: session.sessionId },
      data: {
        currentStatus: "OUTSIDE_OFFICE",
        lastExit: now,
        lastActivity: now,
        updatedAt: now,
      },
    });
  }
  await assignmentEngine.onBrokerLeftOffice(empId).catch(() => null);
  console.log("FORCE_OUTSIDE", label, session?.currentStatus || "no-session");
}

async function main() {
  const {
    attendanceService,
    assignmentEngine,
    isEmployeeInOffice,
    getInOfficeEmployeeIds,
    assignmentOpsService,
  } = await loadDist();

  const brokers = await prisma.user.findMany({
    where: { role: { roleName: "Broker" }, isActive: true },
    include: { employee: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const lia = brokers.find(isLia);
  if (!lia) throw new Error("Lia Torres broker user not found");
  const liaEmpId = lia.employeeId || lia.employee?.employeeId;
  if (!liaEmpId) throw new Error("Lia Torres has no employeeId");

  console.log("=== STEP 1: other brokers → Out of Office ===");
  for (const b of brokers) {
    if (isLia(b)) continue;
    const empId = b.employeeId || b.employee?.employeeId;
    if (!empId) continue;
    await forceOutside(attendanceService, assignmentEngine, empId, nameOf(b));
  }

  console.log("=== STEP 2: Lia Torres → In Office ===");
  await forceInside(attendanceService, assignmentEngine, liaEmpId, nameOf(lia));
  console.log("LIA_IN_OFFICE", await isEmployeeInOffice(liaEmpId));

  console.log("=== STEP 3: wipe all shipments (archive clean slate) ===");
  const before = await prisma.shipmentLead.count();
  console.log("SHIPMENTS_BEFORE", before);
  const result = await assignmentOpsService.cleanSlateAllShipments({
    actorUserId: null,
  });
  console.log("CLEAN_SLATE_RESULT", result);
  const after = await prisma.shipmentLead.count();
  console.log("SHIPMENTS_AFTER", after);

  const empIds = brokers
    .map((b) => b.employeeId || b.employee?.employeeId)
    .filter(Boolean);
  const inOfficeIds = await getInOfficeEmployeeIds(empIds);
  const eligible = await assignmentEngine.resolveEligibleBrokers();
  console.log("=== VERIFY ===", {
    inOfficeEmployeeIds: [...inOfficeIds],
    assignmentMode: eligible.mode,
    eligibleNames: eligible.eligible.map((e) => e.displayName),
    shipmentsRemaining: after,
  });

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

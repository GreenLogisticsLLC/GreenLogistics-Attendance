/**
 * Live diagnose: In Office vs assignment eligible (focus Lia Torres).
 *   node scripts/diagnose-in-office-assign.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const root = process.cwd();
  const [
    { config },
    { getAttendanceWorkDate, getAttendanceDayBounds },
    { getInOfficeEmployeeIds, isEmployeeInOffice, getEmployeePresenceSessionsMap },
    { assignmentEngine },
  ] = await Promise.all([
    import(pathToFileURL(path.join(root, "dist/config/env.js")).href),
    import(pathToFileURL(path.join(root, "dist/utils/helpers.js")).href),
    import(pathToFileURL(path.join(root, "dist/services/attendance-presence.service.js")).href),
    import(pathToFileURL(path.join(root, "dist/modules/assignment/assignment.engine.js")).href),
  ]);

  const now = new Date();
  const tz = config.timezone;
  const workDate = getAttendanceWorkDate(now, tz);
  const bounds = getAttendanceDayBounds(workDate, tz);
  console.log("=== IN OFFICE ASSIGN DIAGNOSE ===");
  console.log({
    nowUTC: now.toISOString(),
    timezone: tz,
    workDate,
    scheduledStart: bounds.scheduledStart.toISOString(),
    scheduledEnd: bounds.scheduledEnd.toISOString(),
    localNow: now.toLocaleString("en-GB", { timeZone: tz, hour12: false }),
  });

  const brokers = await prisma.user.findMany({
    where: { role: { roleName: "Broker" }, isActive: true },
    include: {
      employee: true,
      role: true,
      brokerGmailAccount: {
        select: { status: true, isActive: true, gmailAddress: true, refreshToken: true },
      },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  const empIds = brokers
    .map((b) => b.employeeId || b.employee?.employeeId)
    .filter(Boolean);
  const inOfficeIds = await getInOfficeEmployeeIds(empIds);
  const sessions = await getEmployeePresenceSessionsMap(empIds);

  console.log("=== BROKERS ===");
  for (const b of brokers) {
    const empId = b.employeeId || b.employee?.employeeId || null;
    const session = empId ? sessions.get(empId) : null;
    const inOffice = empId ? inOfficeIds.has(empId) : false;
    const gmail = b.brokerGmailAccount;
    console.log({
      name: `${b.firstName} ${b.lastName}`,
      userId: b.userId,
      employeeId: empId,
      empStatus: b.employee?.status || null,
      linked: Boolean(b.employeeId),
      sessionWorkDate: session?.workDate || null,
      sessionStatus: session?.currentStatus || null,
      firstEntry: session?.firstEntry || null,
      lastActivity: session?.lastActivity || null,
      inOfficeForAssign: inOffice,
      gmail: gmail
        ? {
            status: gmail.status,
            active: gmail.isActive,
            hasRefresh: Boolean(gmail.refreshToken),
            address: gmail.gmailAddress,
          }
        : null,
    });
  }

  const resolved = await assignmentEngine.resolveEligibleBrokers();
  console.log("=== ELIGIBLE ===", {
    mode: resolved.mode,
    count: resolved.eligible.length,
    names: resolved.eligible.map((e) => e.displayName),
  });

  const waiting = await prisma.shipmentLead.findMany({
    where: {
      status: {
        in: ["NEW", "UNASSIGNED", "ASSIGNED", "AWAITING_ACCEPTANCE", "AGENT_OPEN"],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      greenOsShipmentId: true,
      shipmentTitle: true,
      status: true,
      assignedBrokerId: true,
      createdAt: true,
      acceptanceDeadline: true,
    },
  });
  console.log("=== WAITING SHIPMENTS ===", waiting.length);
  for (const s of waiting) {
    const broker = s.assignedBrokerId
      ? brokers.find((b) => b.userId === s.assignedBrokerId)
      : null;
    console.log({
      id: s.greenOsShipmentId,
      title: s.shipmentTitle,
      status: s.status,
      assigned: broker ? `${broker.firstName} ${broker.lastName}` : s.assignedBrokerId,
      createdAt: s.createdAt,
      deadline: s.acceptanceDeadline,
    });
  }

  const lia = brokers.find((b) =>
    `${b.firstName} ${b.lastName}`.toLowerCase().includes("lia")
  );
  if (lia) {
    const empId = lia.employeeId || lia.employee?.employeeId;
    console.log("=== LIA DETAIL ===", {
      name: `${lia.firstName} ${lia.lastName}`,
      inOffice: empId ? await isEmployeeInOffice(empId) : false,
      inEligible: resolved.eligible.some((e) => e.userId === lia.userId),
    });
  } else {
    console.log("=== LIA DETAIL === NOT FOUND as Broker user");
  }

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

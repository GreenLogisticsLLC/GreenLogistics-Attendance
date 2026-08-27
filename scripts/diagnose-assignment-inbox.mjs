/**
 * Live diagnose: who is In Office for assignment + inbox/import health.
 * Run on Contabo: node scripts/diagnose-assignment-inbox.mjs
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function workDateEt(d = new Date()) {
  const local = new Date(
    d.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const hour = local.getHours();
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  let date = `${y}-${m}-${day}`;
  if (hour < 2) {
    const prev = new Date(local);
    prev.setDate(prev.getDate() - 1);
    date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
  }
  return date;
}

function addDays(workDate, days) {
  const [y, m, d] = workDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function presenceSession(employeeId, workDate) {
  let session = await prisma.attendanceSession.findUnique({
    where: { employeeId_workDate: { employeeId, workDate } },
  });
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  // Before 17:00 ET, carry overnight INSIDE from previous attendance day
  if (!session && local.getHours() < 17) {
    const prev = await prisma.attendanceSession.findUnique({
      where: {
        employeeId_workDate: { employeeId, workDate: addDays(workDate, -1) },
      },
    });
    if (prev?.currentStatus === "INSIDE_OFFICE" && now >= prev.scheduledEnd) {
      session = prev;
    }
  }
  return session;
}

async function main() {
  const workDate = workDateEt();
  console.log("WORK_DATE_ET", workDate);

  const brokers = await prisma.user.findMany({
    where: { role: { roleName: "Broker" }, isActive: true },
    include: { employee: true, brokerGmailAccount: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  console.log("=== BROKER PRESENCE (assignment rules) ===");
  const insideNames = [];
  for (const b of brokers) {
    const empId = b.employeeId || b.employee?.employeeId || null;
    const session = empId ? await presenceSession(empId, workDate) : null;
    const inOffice = session?.currentStatus === "INSIDE_OFFICE";
    if (inOffice) insideNames.push(`${b.firstName} ${b.lastName}`);
    console.log({
      name: `${b.firstName} ${b.lastName}`,
      availableFlag: b.availableForAssignment,
      employeeId: empId,
      presenceStatus: session?.currentStatus || null,
      presenceWorkDate: session?.workDate || null,
      inOffice,
      gmail: b.brokerGmailAccount?.status || "NONE",
      gmailError: (b.brokerGmailAccount?.lastError || "").slice(0, 60) || null,
    });
  }
  console.log("=== IN OFFICE FOR ASSIGNMENT ===", insideNames);

  const counts = await prisma.shipmentLead.groupBy({
    by: ["status"],
    where: {
      status: { in: ["NEW", "UNASSIGNED", "ASSIGNED", "AWAITING_ACCEPTANCE", "WORKING"] },
    },
    _count: { _all: true },
  });
  console.log("=== PIPELINE COUNTS ===", counts);

  const unassigned = await prisma.shipmentLead.count({
    where: {
      status: { in: ["NEW", "UNASSIGNED"] },
      OR: [{ assignedBrokerId: null }, { assignedBrokerId: "" }],
    },
  });
  console.log("UNASSIGNED_WAITING", unassigned);

  const gmailSetting = await prisma.setting.findUnique({
    where: { category_settingKey: { category: "gmail", settingKey: "refresh_token" } },
  });
  console.log("COMPANY_GMAIL_HAS_TOKEN", Boolean((gmailSetting?.settingValue || "").trim()));

  const recentImport = await prisma.shipmentImportLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { createdAt: true, eventType: true, message: true, shipmentLeadId: true },
  });
  console.log("=== RECENT IMPORT LOGS ===");
  for (const r of recentImport) {
    console.log({
      at: r.createdAt,
      event: r.eventType,
      message: (r.message || "").slice(0, 100),
      lead: r.shipmentLeadId,
    });
  }

  const recentEmail = await prisma.emailMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      createdAt: true,
      processStatus: true,
      subject: true,
      fromAddress: true,
    },
  });
  console.log("=== RECENT EMAIL MESSAGES ===");
  for (const r of recentEmail) {
    console.log({
      at: r.createdAt,
      status: r.processStatus,
      from: r.fromAddress,
      subject: (r.subject || "").slice(0, 80),
    });
  }

  const queue = await prisma.assignmentQueueState.findUnique({ where: { queueKey: "brokers" } });
  console.log("QUEUE", queue);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

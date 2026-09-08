/**
 * Live diagnose: who is In Office for assignment + inbox/import health.
 * Run on Contabo: node scripts/diagnose-assignment-inbox.mjs
 */
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const TZ = "America/Los_Angeles";

function workDateTz(d = new Date(), timeZone = TZ) {
  const local = new Date(d.toLocaleString("en-US", { timeZone }));
  const hour = local.getHours();
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  // Match src/utils/helpers getAttendanceWorkDate: board name flips at 02:00, not 17:00.
  let date = `${y}-${m}-${day}`;
  if (hour < 2) {
    const prev = new Date(local);
    prev.setDate(prev.getDate() - 1);
    date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
  }
  return { workDate: date, localHour: hour, localIso: local.toISOString() };
}

function addDays(workDate, days) {
  const [y, m, d] = workDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function presenceSession(employeeId, workDate, localHour) {
  let session = await prisma.attendanceSession.findUnique({
    where: { employeeId_workDate: { employeeId, workDate } },
  });
  const now = new Date();
  const todayNotReallyPresent =
    !session ||
    session.currentStatus === "SCHEDULED" ||
    (session.currentStatus !== "INSIDE_OFFICE" &&
      session.currentStatus !== "OUTSIDE_OFFICE" &&
      session.currentStatus !== "COMPLETED" &&
      !session.firstEntry);

  // Before 17:00 board start, carry overnight INSIDE (matches attendance-presence.service).
  if (todayNotReallyPresent && localHour < 17) {
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

/** Diagnose gate aligned with getInOfficeEmployeeIds (America/Los_Angeles bounds). */
function isInOfficeForAssignment(session, _workDate, now = new Date()) {
  if (!session || session.currentStatus !== "INSIDE_OFFICE") return false;
  // 17:00 LA PDT = 00:00 UTC next calendar day; PST = 01:00 UTC next day.
  // Use Intl to get LA wall time for now vs early(13:00)/start(17:00)/end+OT(04:00).
  const laHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .find((p) => p.type === "hour")?.value || 0
  );
  // Eligible window on LA clock: 13:00–23:59 or 00:00–03:59
  if (laHour >= 4 && laHour < 13) return false;
  if (laHour >= 13 && laHour < 17) {
    if (!session.firstEntry) return false;
    const feHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        hour: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(session.firstEntry))
        .find((p) => p.type === "hour")?.value || 0
    );
    if (feHour < 13) return false;
  }
  return true;
}

function loadEnvRefreshToken() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return "";
  const text = readFileSync(envPath, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("GMAIL_REFRESH_TOKEN="));
  return line ? line.slice("GMAIL_REFRESH_TOKEN=".length).trim().replace(/^["']|["']$/g, "") : "";
}

async function probeCompanyGmailUnread(prismaClient) {
  try {
    const { google } = require("googleapis");
    const settings = await prismaClient.setting.findMany({
      where: { category: "gmail" },
    });
    const map = Object.fromEntries(settings.map((s) => [s.settingKey, s.settingValue || ""]));
    const refresh =
      (map.refresh_token || "").trim() || loadEnvRefreshToken();
    const clientId = process.env.GMAIL_CLIENT_ID || "";
    const clientSecret = process.env.GMAIL_CLIENT_SECRET || "";
    const user = (map.user || process.env.GMAIL_USER || "effiegreenlogistics@gmail.com").trim();
    if (!refresh || !clientId || !clientSecret) {
      return {
        ok: false,
        reason: "missing oauth client or refresh token",
        user,
        hasRefresh: Boolean(refresh),
        hasClient: Boolean(clientId && clientSecret),
      };
    }
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refresh });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const queries = [
      "is:unread from:uship.com",
      "is:unread from:uship.com newer_than:2d",
      "from:uship.com newer_than:2d",
      "is:unread subject:(INSTANT ALERT OR Instant Alert OR Saved Search) newer_than:2d",
    ];
    const out = { ok: true, user, counts: {} };
    for (const q of queries) {
      const res = await gmail.users.messages.list({
        userId: user,
        q,
        maxResults: 1,
      });
      // resultSizeEstimate is approximate but good enough for diagnose
      out.counts[q] = {
        estimate: res.data.resultSizeEstimate ?? null,
        sampleIds: (res.data.messages || []).length,
      };
    }
    const importAfterRaw = (map.import_after || "").trim();
    out.import_after = importAfterRaw || null;
    out.connected_at = (map.connected_at || "").trim() || null;
    return out;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const { workDate, localHour, localIso } = workDateTz();
  console.log("NOW_UTC", new Date().toISOString());
  console.log("TZ", TZ, "LOCAL_HOUR", localHour, "LOCAL_SAMPLE", localIso);
  console.log("WORK_DATE", workDate);
  console.log("ENV_TIMEZONE", process.env.TIMEZONE || "(unset → app default America/Los_Angeles)");

  const brokers = await prisma.user.findMany({
    where: { role: { roleName: "Broker" }, isActive: true },
    include: { employee: true, brokerGmailAccount: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  console.log("=== BROKER PRESENCE (assignment rules) ===");
  const insideNames = [];
  let lia = null;
  for (const b of brokers) {
    const empId = b.employeeId || b.employee?.employeeId || null;
    const session = empId ? await presenceSession(empId, workDate, localHour) : null;
    const inOffice = isInOfficeForAssignment(session, workDate);
    if (inOffice) insideNames.push(`${b.firstName} ${b.lastName}`);
    const row = {
      name: `${b.firstName} ${b.lastName}`,
      userId: b.userId,
      availableFlag: b.availableForAssignment,
      employeeId: empId,
      employeeStatus: b.employee?.status || null,
      presenceStatus: session?.currentStatus || null,
      presenceWorkDate: session?.workDate || null,
      firstEntry: session?.firstEntry || null,
      inOffice,
      gmail: b.brokerGmailAccount?.status || "NONE",
      gmailAddress: b.brokerGmailAccount?.gmailAddress || null,
      gmailError: (b.brokerGmailAccount?.lastError || "").slice(0, 80) || null,
    };
    console.log(row);
    if (/lia/i.test(b.firstName) && /torres/i.test(b.lastName || "")) {
      lia = { broker: b, row, session };
    }
  }
  console.log("=== IN OFFICE FOR ASSIGNMENT ===", insideNames);
  console.log(
    "=== ASSIGNMENT MODE ===",
    insideNames.length > 0 ? "in_office" : "none",
    insideNames.length === 0
      ? "(nobody In Office → NEW shipments stay UNASSIGNED)"
      : ""
  );

  // Prove which assignment code is actually running under dist/ (PM2).
  try {
    const { readFileSync: readFs, existsSync: existsFs } = await import("fs");
    const engPath = resolve(process.cwd(), "dist/modules/assignment/assignment.engine.js");
    if (existsFs(engPath)) {
      const src = readFs(engPath, "utf8");
      console.log("DIST_ENGINE_HAS_PARKING", src.includes("parking NEW shipments as UNASSIGNED"));
      console.log("DIST_ENGINE_HAS_FALLBACK", src.includes("all_brokers_fallback") || src.includes("falling back to round-robin"));
      console.log("DIST_ENGINE_MODE_TYPE", /AssignmentPoolMode\s*=\s*"[^"]+"\s*\|\s*"[^"]+"/.test(src) ? "see source map" : "compiled");
    } else {
      console.log("DIST_ENGINE_MISSING", engPath);
    }
    const presencePath = resolve(process.cwd(), "dist/services/attendance-presence.service.js");
    if (existsFs(presencePath)) {
      const psrc = readFs(presencePath, "utf8");
      console.log(
        "DIST_PRESENCE_HAS_SHIFT_WINDOW",
        psrc.includes("earlyArrivalFrom") ||
          psrc.includes("overnightOtEnd") ||
          psrc.includes("early-arrival")
      );
    } else {
      console.log("DIST_PRESENCE_MISSING", presencePath);
    }
  } catch (err) {
    console.log("DIST_ENGINE_CHECK_FAILED", err instanceof Error ? err.message : String(err));
  }

  try {
    const { assignmentEngine } = await import("../dist/modules/assignment/assignment.engine.js");
    if (assignmentEngine?.resolveEligibleBrokers) {
      const live = await assignmentEngine.resolveEligibleBrokers();
      console.log("=== LIVE ENGINE resolveEligibleBrokers ===", {
        mode: live.mode,
        eligibleCount: live.eligible?.length ?? 0,
        eligibleNames: (live.eligible || []).map((e) => e.displayName),
      });
    } else {
      console.log("LIVE_ENGINE_IMPORT", "resolveEligibleBrokers missing on export");
    }
  } catch (err) {
    console.log("LIVE_ENGINE_IMPORT_FAILED", err instanceof Error ? err.message : String(err));
  }

  if (lia) {
    console.log("=== LIA TORRES ===", lia.row);
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const assignedLast2d = await prisma.shipmentLead.count({
      where: {
        assignedBrokerId: lia.broker.userId,
        assignedAt: { gte: since },
      },
    });
    const recentAssigned = await prisma.shipmentLead.findMany({
      where: { assignedBrokerId: lia.broker.userId },
      orderBy: { assignedAt: "desc" },
      take: 5,
      select: {
        shipmentLeadId: true,
        loadNumber: true,
        externalShipmentId: true,
        status: true,
        assignedAt: true,
        shipmentTitle: true,
      },
    });
    console.log("LIA_ASSIGNED_LAST_2D", assignedLast2d);
    console.log("LIA_RECENT_ASSIGNED", recentAssigned);
  } else {
    console.log("=== LIA TORRES === NOT FOUND among active Brokers");
  }

  const counts = await prisma.shipmentLead.groupBy({
    by: ["status"],
    where: {
      status: {
        in: [
          "NEW",
          "UNASSIGNED",
          "ASSIGNED",
          "AWAITING_ACCEPTANCE",
          "WORKING",
          "AGENT_OPEN",
        ],
      },
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

  const gmailSettings = await prisma.setting.findMany({
    where: { category: "gmail" },
  });
  const gmap = Object.fromEntries(
    gmailSettings.map((s) => [s.settingKey, (s.settingValue || "").trim()])
  );
  console.log("COMPANY_GMAIL_HAS_TOKEN", Boolean(gmap.refresh_token));
  console.log("COMPANY_GMAIL_USER", gmap.user || null);
  console.log("COMPANY_GMAIL_CONNECTED_AT", gmap.connected_at || null);
  console.log("COMPANY_IMPORT_AFTER", gmap.import_after || null);

  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const importByType = await prisma.shipmentImportLog.groupBy({
    by: ["eventType"],
    where: { createdAt: { gte: since48h } },
    _count: { _all: true },
  });
  console.log("=== IMPORT LOGS LAST 48H ===", importByType);

  const emailsLast48h = await prisma.emailMessage.count({
    where: { createdAt: { gte: since48h } },
  });
  const leadsCreated48h = await prisma.shipmentLead.count({
    where: { createdAt: { gte: since48h } },
  });
  console.log("EMAIL_MESSAGES_STORED_LAST_48H", emailsLast48h);
  console.log("SHIPMENT_LEADS_CREATED_LAST_48H", leadsCreated48h);

  const recentImport = await prisma.shipmentImportLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { createdAt: true, eventType: true, message: true, shipmentLeadId: true },
  });
  console.log("=== RECENT IMPORT LOGS ===");
  for (const r of recentImport) {
    console.log({
      at: r.createdAt,
      event: r.eventType,
      message: (r.message || "").slice(0, 120),
      lead: r.shipmentLeadId,
    });
  }

  const recentEmail = await prisma.emailMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      createdAt: true,
      processStatus: true,
      subject: true,
      fromAddress: true,
      receivedAt: true,
    },
  });
  console.log("=== RECENT EMAIL MESSAGES ===");
  for (const r of recentEmail) {
    console.log({
      at: r.createdAt,
      receivedAt: r.receivedAt,
      status: r.processStatus,
      from: r.fromAddress,
      subject: (r.subject || "").slice(0, 80),
    });
  }

  const adminLogs = await prisma.assignmentLog.findMany({
    where: {
      eventType: { in: ["ADMIN_REFRESH_MAILING", "ADMIN_CLEAN_SLATE"] },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { createdAt: true, eventType: true, message: true },
  });
  console.log("=== RECENT ADMIN MAIL OPS ===");
  for (const r of adminLogs) {
    console.log({
      at: r.createdAt,
      event: r.eventType,
      message: (r.message || "").slice(0, 160),
    });
  }

  const queue = await prisma.assignmentQueueState.findUnique({
    where: { queueKey: "brokers" },
  });
  console.log("QUEUE", queue);

  let queueOrder = [];
  let nextIndex = 0;
  if (queue?.orderedUserIdsJson) {
    try {
      queueOrder = JSON.parse(queue.orderedUserIdsJson);
    } catch {
      queueOrder = [];
    }
    nextIndex = queue.nextIndex || 0;
  }
  const nextId = queueOrder.length ? queueOrder[nextIndex % queueOrder.length] : null;
  const nextUser = nextId ? brokers.find((b) => b.userId === nextId) : null;
  console.log(
    "NEXT_IN_QUEUE",
    nextUser ? `${nextUser.firstName} ${nextUser.lastName}` : null,
    `(index ${nextIndex}/${queueOrder.length})`
  );
  console.log(
    "QUEUE_ORDER_NAMES",
    queueOrder.map((id) => {
      const b = brokers.find((x) => x.userId === id);
      return b ? `${b.firstName} ${b.lastName}` : id;
    })
  );

  console.log("=== GMAIL UNREAD PROBE ===");
  const probe = await probeCompanyGmailUnread(prisma);
  console.log(JSON.stringify(probe, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

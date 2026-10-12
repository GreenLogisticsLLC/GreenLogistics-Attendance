/**
 * Read-only: verify Day Shift 17:00 / grace 15 / late after 17:15 on production.
 *   node scripts/diagnose-late-settings.mjs
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
    {
      ATTENDANCE_DAY_START,
      ATTENDANCE_GRACE_MINUTES,
      getAttendanceDayBounds,
      getAttendanceWorkDate,
      zonedDateTime,
    },
    { businessRulesEngine },
  ] = await Promise.all([
    import(pathToFileURL(path.join(root, "dist/config/env.js")).href),
    import(pathToFileURL(path.join(root, "dist/utils/helpers.js")).href),
    import(pathToFileURL(path.join(root, "dist/services/business-rules.engine.js")).href),
  ]);

  const tz = config.timezone;
  const now = new Date();
  const workDate = getAttendanceWorkDate(now, tz);
  const bounds = getAttendanceDayBounds(workDate, tz);
  const graceEnd = new Date(bounds.scheduledStart.getTime() + ATTENDANCE_GRACE_MINUTES * 60000);

  console.log("=== LATE SETTINGS DIAGNOSE ===");
  console.log("timezone:", tz);
  console.log("constants:", {
    ATTENDANCE_DAY_START,
    ATTENDANCE_GRACE_MINUTES,
    lateAfter: "17:15",
  });
  console.log("nowUTC:", now.toISOString());
  console.log("workDate:", workDate);
  console.log(
    "scheduledStart:",
    bounds.scheduledStart.toISOString(),
    "| local",
    bounds.scheduledStart.toLocaleString("en-GB", { timeZone: tz, hour12: false })
  );
  console.log(
    "graceEnd(17:15):",
    graceEnd.toISOString(),
    "| local",
    graceEnd.toLocaleString("en-GB", { timeZone: tz, hour12: false })
  );

  // Boundary calc smoke
  for (const t of ["17:15", "17:16", "17:35"]) {
    const entry = zonedDateTime(workDate, t, tz);
    const r = businessRulesEngine.calculateLateStatus(
      entry,
      bounds.scheduledStart,
      ATTENDANCE_GRACE_MINUTES
    );
    console.log(`calc ${t} => late=${r.late} minutes=${r.lateMinutes}`);
  }

  const shifts = await prisma.shift.findMany({
    select: {
      shiftName: true,
      startTime: true,
      endTime: true,
      gracePeriodMinutes: true,
      crossMidnight: true,
      isActive: true,
      _count: { select: { employees: true } },
    },
  });
  console.log("SHIFTS", shifts);

  const active = await prisma.employee.findMany({
    where: { status: "ACTIVE" },
    include: { shift: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  const wrongShift = active.filter(
    (e) =>
      !e.shift ||
      e.shift.startTime !== "17:00" ||
      e.shift.gracePeriodMinutes !== 15
  );
  console.log("ACTIVE_EMPLOYEES", active.length);
  console.log(
    "WRONG_SHIFT_OR_GRACE",
    wrongShift.map((e) => ({
      name: `${e.firstName} ${e.lastName}`,
      shift: e.shift?.shiftName,
      start: e.shift?.startTime,
      grace: e.shift?.gracePeriodMinutes,
    }))
  );

  const sessions = await prisma.attendanceSession.findMany({
    where: { workDate },
    include: {
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
    },
    orderBy: { firstEntry: "asc" },
  });

  console.log("TODAY_SESSIONS", sessions.length);
  for (const s of sessions) {
    const name = `${s.employee.firstName} ${s.employee.lastName}`;
    const firstLocal = s.firstEntry
      ? s.firstEntry.toLocaleString("en-GB", { timeZone: tz, hour12: false })
      : null;
    let recomputed = null;
    if (s.firstEntry) {
      recomputed = businessRulesEngine.calculateLateStatus(
        s.firstEntry,
        s.scheduledStart,
        ATTENDANCE_GRACE_MINUTES
      );
    }
    const mismatch =
      recomputed &&
      (Boolean(s.late) !== recomputed.late ||
        Number(s.lateMinutes || 0) !== Number(recomputed.lateMinutes || 0));
    console.log({
      name,
      status: s.currentStatus,
      firstEntry: firstLocal,
      late: s.late,
      lateMinutes: s.lateMinutes,
      recomputed,
      mismatch: Boolean(mismatch),
      scheduledStartLocal: s.scheduledStart.toLocaleString("en-GB", {
        timeZone: tz,
        hour12: false,
      }),
    });
  }

  const lateRows = sessions.filter((s) => s.late && (s.lateMinutes || 0) > 0);
  console.log(
    "LATE_TODAY",
    lateRows.map((s) => ({
      name: `${s.employee.firstName} ${s.employee.lastName}`,
      lateMinutes: s.lateMinutes,
      firstEntry: s.firstEntry
        ? s.firstEntry.toLocaleString("en-GB", { timeZone: tz, hour12: false })
        : null,
    }))
  );
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

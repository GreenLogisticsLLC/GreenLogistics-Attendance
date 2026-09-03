/**
 * Diagnose an attendance badge by name and mark them In Office.
 *   node scripts/checkin-employee-by-name.mjs Andy
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const query = (process.argv.slice(2).join(" ") || "Andy").trim().toLowerCase();

async function loadAttendance() {
    const root = process.cwd();
    const [{ attendanceService }, { isEmployeeInOffice }] = await Promise.all([
        import(pathToFileURL(path.join(root, "dist/services/attendance.service.js")).href),
        import(pathToFileURL(path.join(root, "dist/services/attendance-presence.service.js")).href),
    ]);
    return { attendanceService, isEmployeeInOffice };
}

function nameOf(row) {
    return `${row.firstName || ""} ${row.lastName || ""}`.trim();
}

function matches(row) {
    const blob = `${row.firstName || ""} ${row.lastName || ""} ${row.username || ""}`.toLowerCase();
    const parts = query.split(/\s+/).filter(Boolean);
    return parts.every((part) => blob.includes(part));
}

async function main() {
    const { attendanceService, isEmployeeInOffice } = await loadAttendance();

    const employees = await prisma.employee.findMany({
        include: { shift: true },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    const users = await prisma.user.findMany({
        where: { isActive: true },
        select: {
            userId: true,
            firstName: true,
            lastName: true,
            username: true,
            employeeId: true,
            role: { select: { roleName: true } },
        },
    });

    const empHits = employees.filter(matches);
    const userHits = users.filter(matches);
    console.log("=== QUERY ===", query);
    console.log(
        "=== EMPLOYEES ===",
        empHits.map((e) => ({
            employeeId: e.employeeId,
            name: nameOf(e),
            number: e.employeeNumber,
            card: e.cardNumber,
            status: e.status,
            shift: e.shift?.shiftName || null,
            shiftId: e.shiftId,
        }))
    );
    console.log(
        "=== USERS ===",
        userHits.map((u) => ({
            name: nameOf(u),
            username: u.username,
            role: u.role?.roleName,
            employeeId: u.employeeId,
        }))
    );

    const pending = await prisma.pendingCardScan.findMany({
        where: { registered: false },
        orderBy: { scannedAt: "desc" },
        take: 15,
    });
    console.log(
        "=== PENDING CARDS ===",
        pending.map((p) => ({
            cardToken: p.cardToken,
            deviceId: p.deviceId,
            scannedAt: p.scannedAt,
        }))
    );

    const logs = await prisma.webhookLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
            employeeIdentifier: true,
            processingStatus: true,
            errorMessage: true,
            createdAt: true,
            responseCode: true,
        },
    });
    console.log("=== RECENT WEBHOOKS ===", logs);

    const targets = empHits.length
        ? empHits
        : userHits
              .map((u) => employees.find((e) => e.employeeId === u.employeeId))
              .filter(Boolean);

    if (!targets.length) {
        throw new Error(`No employee matched "${query}"`);
    }

    for (const emp of targets) {
        const empId = emp.employeeId;
        const events = await prisma.attendanceEvent.findMany({
            where: { employeeId: empId },
            orderBy: { eventTime: "desc" },
            take: 8,
        });
        console.log("=== EVENTS", nameOf(emp), "===");
        console.log(
            events.map((ev) => ({
                at: ev.eventTime,
                direction: ev.direction,
                type: ev.eventType,
                source: ev.source,
            }))
        );

        const already = await isEmployeeInOffice(empId);
        console.log("IN_OFFICE_BEFORE", nameOf(emp), already);
        if (already) continue;

        const now = new Date();
        const result = await attendanceService.processEvent({
            employeeId: empId,
            eventTime: now,
            direction: "ENTRY",
            deviceId: "ops-door-checkin",
            webhookId: `ops-door-checkin|${empId}|${now.toISOString()}|enter`,
            source: "OPS_DOOR_CHECKIN",
        });
        console.log("CHECKED_IN", nameOf(emp), {
            status: result.session?.currentStatus,
            duplicate: Boolean(result.duplicate),
        });
        console.log("IN_OFFICE_AFTER", nameOf(emp), await isEmployeeInOffice(empId));
    }

    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
});

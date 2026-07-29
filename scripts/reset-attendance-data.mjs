import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../dist/config/database.js";

const REQUIRED_CONFIRMATION = "RESET_ATTENDANCE_HISTORY";
const dryRun = process.argv.includes("--dry-run");
const confirmed = process.argv.includes(`--confirm=${REQUIRED_CONFIRMATION}`);

if (!dryRun && !confirmed) {
    console.error(`Refusing to reset attendance data. Pass --confirm=${REQUIRED_CONFIRMATION}`);
    process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function backupSqlite() {
    const databaseUrl = process.env.DATABASE_URL || "";
    if (!databaseUrl.startsWith("file:")) {
        console.log("[attendance-reset] Non-SQLite database; create an external DB backup first.");
        return null;
    }

    const backupDir = path.join(root, "data", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `attendance-before-reset-${stamp}.db`);
    const escapedPath = backupPath.replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`VACUUM INTO '${escapedPath}'`);
    console.log(`[attendance-reset] Backup created: ${backupPath}`);
    return backupPath;
}

async function main() {
    const before = {
        employees: await prisma.employee.count(),
        shipments: await prisma.shipmentLead.count(),
        sessions: await prisma.attendanceSession.count(),
        events: await prisma.attendanceEvent.count(),
        absences: await prisma.absenceInterval.count(),
        webhookLogs: await prisma.webhookLog.count(),
        notifications: await prisma.notification.count(),
    };

    if (dryRun) {
        console.log("[attendance-reset] Dry run; no data changed:", JSON.stringify(before));
        return;
    }

    await backupSqlite();

    await prisma.$transaction([
        prisma.absenceInterval.deleteMany(),
        prisma.attendanceEvent.deleteMany(),
        prisma.attendanceSession.deleteMany(),
        prisma.webhookLog.deleteMany(),
        prisma.notification.deleteMany(),
    ]);

    const after = {
        employees: await prisma.employee.count(),
        shipments: await prisma.shipmentLead.count(),
        sessions: await prisma.attendanceSession.count(),
        events: await prisma.attendanceEvent.count(),
        absences: await prisma.absenceInterval.count(),
        webhookLogs: await prisma.webhookLog.count(),
        notifications: await prisma.notification.count(),
    };

    if (after.employees !== before.employees || after.shipments !== before.shipments) {
        throw new Error("Safety check failed: employee or shipment count changed");
    }
    if (
        after.sessions !== 0 ||
        after.events !== 0 ||
        after.absences !== 0 ||
        after.webhookLogs !== 0 ||
        after.notifications !== 0
    ) {
        throw new Error("Attendance reset verification failed");
    }

    console.log("[attendance-reset] Before:", JSON.stringify(before));
    console.log("[attendance-reset] After:", JSON.stringify(after));
    console.log("[attendance-reset] Attendance history cleared; employees and shipments preserved.");
}

main()
    .catch((error) => {
        console.error("[attendance-reset] FAILED:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

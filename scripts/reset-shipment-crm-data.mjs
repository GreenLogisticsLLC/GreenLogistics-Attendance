import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../dist/config/database.js";

const REQUIRED_CONFIRMATION = "RESET_SHIPMENT_CRM";
const dryRun = process.argv.includes("--dry-run");
const confirmed = process.argv.includes(`--confirm=${REQUIRED_CONFIRMATION}`);

if (!dryRun && !confirmed) {
    console.error(`Refusing to reset shipment CRM. Pass --confirm=${REQUIRED_CONFIRMATION}`);
    process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function backupSqlite() {
    const databaseUrl = process.env.DATABASE_URL || "";
    if (!databaseUrl.startsWith("file:")) {
        console.log("[crm-reset] Non-SQLite database; create an external DB backup first.");
        return null;
    }

    const backupDir = path.join(root, "data", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `crm-before-reset-${stamp}.db`);
    const escapedPath = backupPath.replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`VACUUM INTO '${escapedPath}'`);
    console.log(`[crm-reset] Backup created: ${backupPath}`);
    return backupPath;
}

async function main() {
    const before = {
        users: await prisma.user.count(),
        employees: await prisma.employee.count(),
        shipments: await prisma.shipmentLead.count(),
        domainEvents: await prisma.domainEvent.count(),
        timeline: await prisma.shipmentTimelineEvent.count(),
        importLogs: await prisma.shipmentImportLog.count(),
        mailbox: await prisma.brokerMailboxMessage.count(),
        assignmentLogs: await prisma.assignmentLog.count(),
        platformNotifications: await prisma.platformNotification.count(),
        gmailAccounts: await prisma.brokerGmailAccount.count(),
        attendanceSessions: await prisma.attendanceSession.count(),
    };

    if (dryRun) {
        console.log("[crm-reset] Dry run; no data changed:", JSON.stringify(before));
        return;
    }

    await backupSqlite();

    await prisma.$transaction([
        prisma.platformNotification.deleteMany(),
        prisma.domainEvent.deleteMany(),
        prisma.shipmentTimelineEvent.deleteMany(),
        prisma.shipmentImportLog.deleteMany(),
        prisma.brokerMailboxMessage.deleteMany(),
        prisma.assignmentLog.deleteMany(),
        prisma.shipmentLead.deleteMany(),
    ]);

    await prisma.assignmentQueueState.upsert({
        where: { queueKey: "brokers" },
        update: { orderedUserIdsJson: "[]", nextIndex: 0 },
        create: { queueKey: "brokers", orderedUserIdsJson: "[]", nextIndex: 0 },
    });

    const after = {
        users: await prisma.user.count(),
        employees: await prisma.employee.count(),
        shipments: await prisma.shipmentLead.count(),
        domainEvents: await prisma.domainEvent.count(),
        timeline: await prisma.shipmentTimelineEvent.count(),
        importLogs: await prisma.shipmentImportLog.count(),
        mailbox: await prisma.brokerMailboxMessage.count(),
        assignmentLogs: await prisma.assignmentLog.count(),
        platformNotifications: await prisma.platformNotification.count(),
        gmailAccounts: await prisma.brokerGmailAccount.count(),
        attendanceSessions: await prisma.attendanceSession.count(),
    };

    if (after.users !== before.users || after.employees !== before.employees) {
        throw new Error("Safety check failed: user or employee count changed");
    }
    if (after.gmailAccounts !== before.gmailAccounts) {
        throw new Error("Safety check failed: Gmail accounts changed");
    }
    if (after.attendanceSessions !== before.attendanceSessions) {
        throw new Error("Safety check failed: attendance sessions changed");
    }
    if (
        after.shipments !== 0 ||
        after.domainEvents !== 0 ||
        after.timeline !== 0 ||
        after.importLogs !== 0 ||
        after.mailbox !== 0 ||
        after.assignmentLogs !== 0 ||
        after.platformNotifications !== 0
    ) {
        throw new Error("CRM reset verification failed");
    }

    console.log("[crm-reset] Before:", JSON.stringify(before));
    console.log("[crm-reset] After:", JSON.stringify(after));
    console.log(
        "[crm-reset] Shipment CRM cleared; users, Team Leads, brokers, Gmail, attendance preserved. Queue reset."
    );
}

main()
    .catch((error) => {
        console.error("[crm-reset] FAILED:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

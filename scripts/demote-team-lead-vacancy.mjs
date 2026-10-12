#!/usr/bin/env node
/**
 * Demote a Team Lead and leave the seat vacant (no replacement).
 *
 * Usage on the server (with DATABASE_URL set):
 *   node scripts/demote-team-lead-vacancy.mjs --name Carla --to Broker
 *   node scripts/demote-team-lead-vacancy.mjs --userId <uuid> --to Broker
 *
 * Brokers under that TL get teamLeadId=null until Owner assigns a new TL.
 */
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
    const i = args.indexOf(`--${name}`);
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return fallback;
}

const nameQ = String(arg("name", "") || "").trim().toLowerCase();
const userIdArg = String(arg("userId", "") || "").trim();
const toRole = String(arg("to", "Broker") || "Broker").trim();
const dryRun = args.includes("--dry-run");

if (!nameQ && !userIdArg) {
    console.error("Pass --name Carla or --userId <uuid>");
    process.exit(1);
}

const prisma = new PrismaClient();

async function ensureRole(roleName) {
    return prisma.role.upsert({
        where: { roleName },
        update: {},
        create: { roleName, description: roleName },
    });
}

async function main() {
    const users = await prisma.user.findMany({
        where: userIdArg
            ? { userId: userIdArg }
            : {
                  OR: [
                      { firstName: { contains: nameQ } },
                      { lastName: { contains: nameQ } },
                      { username: { contains: nameQ } },
                      { email: { contains: nameQ } },
                  ],
              },
        include: { role: true },
    });

    // Prefer exact Team Lead match when searching by name.
    let target =
        users.find((u) => u.role.roleName === "Team Lead") ||
        users[0] ||
        null;

    if (!target && nameQ) {
        // SQLite/Postgres case sensitivity — fallback scan
        const all = await prisma.user.findMany({ include: { role: true } });
        const hits = all.filter((u) => {
            const blob = `${u.firstName} ${u.lastName} ${u.username} ${u.email || ""}`.toLowerCase();
            return blob.includes(nameQ);
        });
        target = hits.find((u) => u.role.roleName === "Team Lead") || hits[0] || null;
    }

    if (!target) {
        console.error("User not found");
        process.exit(2);
    }

    console.log(
        `Found: ${target.firstName} ${target.lastName} (${target.username}) role=${target.role.roleName} id=${target.userId}`
    );

    if (target.role.roleName !== "Team Lead") {
        console.error(`Not a Team Lead (current: ${target.role.roleName}). Aborting.`);
        process.exit(3);
    }

    const brokers = await prisma.user.findMany({
        where: {
            teamLeadId: target.userId,
            role: { roleName: "Broker" },
        },
        select: { userId: true, username: true, firstName: true, lastName: true },
    });
    console.log(`Brokers under this TL: ${brokers.length}`);
    brokers.forEach((b) =>
        console.log(`  - ${b.firstName} ${b.lastName} (${b.username})`)
    );

    if (dryRun) {
        console.log("[dry-run] No changes written.");
        return;
    }

    const role = await ensureRole(toRole);
    const cleared = await prisma.user.updateMany({
        where: {
            teamLeadId: target.userId,
            role: { roleName: "Broker" },
        },
        data: { teamLeadId: null },
    });

    await prisma.user.update({
        where: { userId: target.userId },
        data: { roleId: role.roleId, teamLeadId: null },
    });

    // Keep Attendance badge position in sync when linked.
    if (target.employeeId) {
        try {
            await prisma.employee.update({
                where: { employeeId: target.employeeId },
                data: { position: toRole },
            });
        } catch (err) {
            console.warn("Employee position sync skipped:", err.message || err);
        }
    }

    console.log(
        `Done. ${target.firstName} is now ${toRole}. Unassigned ${cleared.count} broker(s). Team Lead seat left vacant for Owner.`
    );
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

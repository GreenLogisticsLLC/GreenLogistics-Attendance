import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const adminRole = await prisma.role.upsert({
        where: { roleName: "Administrator" },
        update: {},
        create: { roleName: "Administrator", description: "Full system access" },
    });

    await prisma.role.upsert({
        where: { roleName: "Manager" },
        update: {},
        create: { roleName: "Manager", description: "Operational management" },
    });

    await prisma.role.upsert({
        where: { roleName: "Viewer" },
        update: {},
        create: { roleName: "Viewer", description: "Read only access" },
    });

    const dayShift = await prisma.shift.upsert({
        where: { shiftName: "Day Shift" },
        update: {},
        create: {
            shiftName: "Day Shift",
            startTime: "17:00",
            endTime: "01:00",
            gracePeriodMinutes: 15,
            crossMidnight: true,
        },
    });

    const nightShift = await prisma.shift.upsert({
        where: { shiftName: "Night Shift" },
        update: {},
        create: {
            shiftName: "Night Shift",
            startTime: "00:00",
            endTime: "05:00",
            gracePeriodMinutes: 15,
            crossMidnight: false,
        },
    });

    const passwordHash = await bcrypt.hash("Admin123!@Green", 12);
    await prisma.user.upsert({
        where: { username: "admin" },
        update: {},
        create: {
            username: "admin",
            passwordHash,
            firstName: "System",
            lastName: "Administrator",
            email: "admin@greenlogistics.local",
            roleId: adminRole.roleId,
        },
    });

    const settings = [
        ["attendance", "grace_period_minutes", "15", "Grace period before late"],
        ["dashboard", "refresh_interval_seconds", "5", "Dashboard refresh interval"],
        ["application", "timezone", "Asia/Yerevan", "Company timezone"],
        ["application", "company_name", "Green Logistics", "Company name"],
        ["security", "jwt_expiration_hours", "8", "JWT lifetime"],
        ["legacy", "auto_sync", "false", "Auto sync cards to access device"],
    ];

    for (const [category, key, value, description] of settings) {
        await prisma.setting.upsert({
            where: { category_settingKey: { category, settingKey: key } },
            update: { settingValue: value },
            create: { category, settingKey: key, settingValue: value, description },
        });
    }

    const sampleEmployees = [
        {
            employeeNumber: "GL-001",
            firstName: "Art",
            lastName: "Grigoryan",
            department: "Operations",
            position: "Team Lead",
            cardNumber: "0aab3c5d",
            externalRef: "ORD-10045",
            shiftId: dayShift.shiftId,
        },
        {
            employeeNumber: "GL-002",
            firstName: "Anna",
            lastName: "Petrosyan",
            department: "Logistics",
            position: "Coordinator",
            cardNumber: "1bcc4e6e",
            externalRef: "ORD-10046",
            shiftId: dayShift.shiftId,
        },
        {
            employeeNumber: "GL-003",
            firstName: "David",
            lastName: "Hakobyan",
            department: "Warehouse",
            position: "Operator",
            cardNumber: "2cdd5f7f",
            externalRef: "ORD-10047",
            shiftId: nightShift.shiftId,
        },
    ];

    for (const emp of sampleEmployees) {
        await prisma.employee.upsert({
            where: { employeeNumber: emp.employeeNumber },
            update: { cardNumber: emp.cardNumber, externalRef: emp.externalRef },
            create: emp,
        });
    }

    console.log("Seed completed.");
    console.log("Login: admin / Admin123!@Green");
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const needle = process.argv[2] || "1234545";

async function main() {
    const rows = await prisma.carrier.findMany({
        where: {
            OR: [
                { mcNumber: { contains: needle } },
                { mcNumber: { equals: needle } },
                { mcNumber: { equals: `MC${needle}` } },
                { mcNumber: { equals: `MC-${needle}` } },
            ],
        },
        select: {
            carrierId: true,
            legalName: true,
            dbaName: true,
            mcNumber: true,
            status: true,
            onboardingStatus: true,
            assignedBrokerId: true,
        },
        take: 20,
    });
    console.log(JSON.stringify({ needle, count: rows.length, rows }, null, 2));

    const sample = await prisma.carrier.findMany({
        take: 10,
        select: { carrierId: true, legalName: true, mcNumber: true, status: true },
        orderBy: { updatedAt: "desc" },
    });
    console.log(JSON.stringify({ sampleMcFormats: sample }, null, 2));
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

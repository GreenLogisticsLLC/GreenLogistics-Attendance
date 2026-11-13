import { prisma, configureSqlite, resolveDatabaseUrl } from "../src/config/database.js";

async function main() {
    process.env.DATABASE_URL = resolveDatabaseUrl();
    await configureSqlite();
    const existing = await prisma.shipmentLead.findFirst({
        where: { loadNumber: "GL19999" },
        select: { shipmentLeadId: true, loadNumber: true, customerRate: true },
    });
    if (existing) {
        console.log(JSON.stringify({ ok: true, existing }));
        return;
    }
    const s = await prisma.shipmentLead.create({
        data: {
            source: "MANUAL",
            shipmentTitle: "PayPal test load",
            customerName: "Acme Foods LLC",
            customerEmail: "billing@acme.test",
            pickupCity: "Dallas",
            pickupState: "TX",
            deliveryCity: "Atlanta",
            deliveryState: "GA",
            status: "CUSTOMER_INVOICE",
            loadNumber: "GL19999",
            customerRate: 1500,
            accessorialCharges: 0,
            customerPaymentMethod: "PAYPAL",
            invoiceNumber: "INV-19999",
            accountingReadyForBilling: true,
        },
        select: { shipmentLeadId: true, loadNumber: true },
    });
    console.log(JSON.stringify({ ok: true, created: s }));
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

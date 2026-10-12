/**
 * Production ops: wipe ALL shipment / load CRM history (clean slate).
 *
 * Contabo (after build):
 *   node scripts/ops-clean-slate-shipments.mjs --confirm=CLEAN_SLATE_SHIPMENTS
 *
 * Keeps users, attendance, carriers, Gmail OAuth. Sets mailing import cutoff to now.
 */
import { pathToFileURL } from "url";
import path from "path";
import fs from "fs";
import { createRequire } from "module";

const REQUIRED = "CLEAN_SLATE_SHIPMENTS";
const confirmed = process.argv.includes(`--confirm=${REQUIRED}`);
if (!confirmed) {
  console.error(`Refusing. Pass --confirm=${REQUIRED}`);
  process.exit(2);
}

const root = process.cwd();
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function backupSqlite() {
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!String(databaseUrl).startsWith("file:")) {
    console.log("[clean-slate] Non-SQLite DB — skip local VACUUM backup");
    return null;
  }
  const backupDir = path.join(root, "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `shipments-before-clean-slate-${stamp}.db`);
  const escaped = backupPath.replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${escaped}'`);
  console.log("[clean-slate] Backup:", backupPath);
  return backupPath;
}

async function main() {
  const before = await prisma.shipmentLead.count();
  console.log("[clean-slate] SHIPMENTS_BEFORE", before);
  await backupSqlite().catch((err) => {
    console.warn("[clean-slate] backup skipped:", err?.message || err);
  });

  const { assignmentOpsService } = await import(
    pathToFileURL(path.join(root, "dist/modules/assignment/services/assignment-ops.service.js")).href
  );

  const result = await assignmentOpsService.cleanSlateAllShipments({
    actorUserId: null,
  });
  const after = await prisma.shipmentLead.count();
  console.log("[clean-slate] RESULT", JSON.stringify(result));
  console.log("[clean-slate] SHIPMENTS_AFTER", after);
  if (after !== 0) {
    throw new Error(`Expected 0 shipments remaining, got ${after}`);
  }

  // Reset Load Number + GOS Shipment ID sequences so the next lot starts fresh.
  await prisma.setting.upsert({
    where: {
      category_settingKey: { category: "shipment", settingKey: "next_load_number" },
    },
    create: {
      category: "shipment",
      settingKey: "next_load_number",
      settingValue: "GL100001",
      description: "Next Green OS Load Number (GL100001… series)",
    },
    update: { settingValue: "GL100001" },
  });
  await prisma.setting.upsert({
    where: {
      category_settingKey: {
        category: "shipment",
        settingKey: "next_green_os_shipment_id",
      },
    },
    create: {
      category: "shipment",
      settingKey: "next_green_os_shipment_id",
      settingValue: "GOS1000001",
      description: "Next Green OS Shipment ID (GOS1000001… series)",
    },
    update: { settingValue: "GOS1000001" },
  });
  console.log("[clean-slate] SEQUENCES_RESET next_load_number=GL100001 next_green_os_shipment_id=GOS1000001");

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => null);
  process.exit(1);
});

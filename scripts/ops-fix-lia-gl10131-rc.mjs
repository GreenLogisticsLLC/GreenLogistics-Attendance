/**
 * One-shot: unlock Generate Rate Confirmation on Lia's load GL10131.
 *   node scripts/ops-fix-lia-gl10131-rc.mjs --confirm=FIX_LIA_GL10131_RC
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CONFIRM = "FIX_LIA_GL10131_RC";
const LOAD_NUMBER = "GL10131";
const GOS_ID = "GOS1001160";

async function main() {
  if (!process.argv.includes(`--confirm=${CONFIRM}`)) {
    console.error("Refusing without --confirm=" + CONFIRM);
    process.exitCode = 1;
    return;
  }

  console.log("=== FIX LIA GL10131 GENERATE RC ===");

  const lia = await prisma.user.findFirst({
    where: {
      isActive: true,
      OR: [
        { firstName: { contains: "Lia" } },
        { username: { contains: "lia" } },
      ],
    },
    select: {
      userId: true,
      firstName: true,
      lastName: true,
      username: true,
      email: true,
    },
  });
  const liaMatches = lia
    ? `${lia.firstName || ""} ${lia.lastName || ""}`.trim().toLowerCase()
    : "";
  const liaOk =
    lia &&
    (liaMatches.includes("lia") || String(lia.username || "").toLowerCase().includes("lia"));
  console.log(
    "LIA",
    liaOk
      ? {
          userId: lia.userId,
          name: `${lia.firstName || ""} ${lia.lastName || ""}`.trim(),
          username: lia.username,
        }
      : null
  );

  const lead = await prisma.shipmentLead.findFirst({
    where: {
      OR: [{ loadNumber: LOAD_NUMBER }, { greenOsShipmentId: GOS_ID }],
    },
    select: {
      shipmentLeadId: true,
      loadNumber: true,
      greenOsShipmentId: true,
      status: true,
      assignedBrokerId: true,
      carrierName: true,
      carrierProfileId: true,
      carrierMc: true,
      carrierDot: true,
      carrierPhone: true,
      carrierEmail: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      loadCarrierApprovedAt: true,
      loadCarrierApprovedById: true,
      loadCarrierApprovedProfileId: true,
      carrierStatus: true,
    },
  });
  if (!lead) {
    console.log("LOAD_NOT_FOUND", { LOAD_NUMBER, GOS_ID });
    return;
  }
  console.log("LOAD_BEFORE", lead);

  let profile = null;
  if (lead.carrierProfileId) {
    profile = await prisma.carrier.findUnique({
      where: { carrierId: lead.carrierProfileId },
      select: {
        carrierId: true,
        legalName: true,
        dbaName: true,
        mcNumber: true,
        dotNumber: true,
        phone: true,
        email: true,
        onboardingStatus: true,
      },
    });
  }
  if (!profile && lead.carrierName) {
    profile = await prisma.carrier.findFirst({
      where: {
        OR: [
          { legalName: { contains: String(lead.carrierName).slice(0, 24) } },
          { dbaName: { contains: String(lead.carrierName).slice(0, 24) } },
        ],
      },
      select: {
        carrierId: true,
        legalName: true,
        dbaName: true,
        mcNumber: true,
        dotNumber: true,
        phone: true,
        email: true,
        onboardingStatus: true,
      },
    });
  }
  console.log("CARRIER_PROFILE", profile);

  const profileId = profile?.carrierId || lead.carrierProfileId || null;
  const carrierName =
    String(lead.carrierName || "").trim() ||
    String(profile?.legalName || profile?.dbaName || "").trim() ||
    null;
  const now = new Date();
  const data = {
    carrierProfileId: profileId,
    carrierName,
    carrierMc: lead.carrierMc || profile?.mcNumber || null,
    carrierDot: lead.carrierDot || profile?.dotNumber || null,
    carrierPhone: lead.carrierPhone || profile?.phone || null,
    carrierEmail: lead.carrierEmail || profile?.email || null,
    carrierStatus: "Approved",
    loadCarrierApprovedAt: lead.loadCarrierApprovedAt || now,
    loadCarrierApprovedById:
      lead.loadCarrierApprovedById || (liaOk ? lia.userId : lead.assignedBrokerId) || null,
    loadCarrierApprovedProfileId: profileId,
    isReassignment: undefined,
  };
  // Prisma rejects undefined in some versions — strip undefined keys.
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

  // Keep existing customer contact; never invent emails.
  if (!String(lead.customerName || "").trim() && liaOk) {
    data.customerName = `${lia.firstName || "Lia"} ${lia.lastName || ""}`.trim();
  }

  const updated = await prisma.shipmentLead.update({
    where: { shipmentLeadId: lead.shipmentLeadId },
    data,
    select: {
      shipmentLeadId: true,
      loadNumber: true,
      greenOsShipmentId: true,
      carrierName: true,
      carrierProfileId: true,
      carrierMc: true,
      carrierDot: true,
      carrierPhone: true,
      carrierEmail: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      loadCarrierApprovedAt: true,
      loadCarrierApprovedById: true,
      loadCarrierApprovedProfileId: true,
      carrierStatus: true,
      assignedBrokerId: true,
    },
  });
  console.log("LOAD_AFTER", updated);
  console.log(
    "RC_UNLOCK_READY",
    Boolean(
      updated.loadCarrierApprovedAt &&
        updated.carrierProfileId &&
        updated.loadCarrierApprovedProfileId === updated.carrierProfileId &&
        String(updated.carrierName || "").trim()
    )
  );
  console.log("=== DONE ===");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });

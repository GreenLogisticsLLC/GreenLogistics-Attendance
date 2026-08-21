import { prisma } from "../../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { normalizeMc, normalizeLoadNumber } from "../documents/normalize.js";
import { prioritizeRecommendations, recommendation } from "./recommendations.js";
import type { OperationalActor } from "./carrier-context.js";
import type {
    DocumentChecklistItem,
    OperationalRecommendation,
    OperationalSource,
    ShipmentOperationalSummary,
    ShipmentReadiness,
} from "./types.js";

const SHIPMENT_DOC_SLOTS = [
    { slot: "RATE_CONFIRMATION", types: ["RATE_CONFIRMATION"] },
    { slot: "BOL", types: ["BOL"] },
    { slot: "POD", types: ["POD"] },
] as const;

function mapLoadDocStatus(
    hasDoc: boolean,
    validationStatus: string | null,
    signatureStatus: string | null
): DocumentChecklistItem["status"] {
    if (!hasDoc) return "MISSING";
    if (validationStatus === "VALID") return "VALID";
    if (validationStatus === "UNSIGNED" || signatureStatus?.includes("MISSING")) {
        return "REVIEW_REQUIRED";
    }
    if (validationStatus === "EXPIRED" || validationStatus === "INVALID") return "INVALID";
    if (validationStatus === "REVIEW_REQUIRED" || !validationStatus) return "REVIEW_REQUIRED";
    return "PRESENT";
}

function deriveShipmentReadiness(
    checklist: DocumentChecklistItem[],
    status: string
): { readiness: ShipmentReadiness; reviewItems: string[] } {
    const reviewItems: string[] = [];
    const pod = checklist.find((d) => d.slot === "POD");
    const bol = checklist.find((d) => d.slot === "BOL");
    const rc = checklist.find((d) => d.slot === "RATE_CONFIRMATION");

    if (pod?.status === "MISSING") reviewItems.push("POD missing");
    if (pod?.status === "REVIEW_REQUIRED") {
        reviewItems.push(pod.reason || "POD requires review (signature/validation)");
    }
    if (pod?.status === "INVALID") reviewItems.push(`POD invalid — ${pod.reason}`);
    if (bol?.status === "MISSING") reviewItems.push("BOL missing");
    if (rc?.status === "MISSING") reviewItems.push("Rate Confirmation missing");

    const critical = checklist.some((d) => d.status === "INVALID" || d.status === "EXPIRED");
    if (critical) {
        return { readiness: "NOT_READY", reviewItems };
    }

    const allGood =
        pod?.status === "VALID" &&
        bol &&
        bol.status !== "MISSING" &&
        bol.status !== "INVALID" &&
        rc &&
        rc.status !== "MISSING" &&
        rc.status !== "INVALID";

    if (allGood) {
        return { readiness: "READY_TO_CLOSE", reviewItems };
    }

    if (reviewItems.length || checklist.some((d) => d.status === "REVIEW_REQUIRED" || d.status === "PRESENT")) {
        return { readiness: "REVIEW_REQUIRED", reviewItems };
    }

    if (["DELIVERED", "COMPLETED", "CLOSED"].includes(status.toUpperCase()) && pod?.status === "VALID") {
        return { readiness: "READY_TO_CLOSE", reviewItems };
    }

    return {
        readiness: reviewItems.length ? "REVIEW_REQUIRED" : "INCOMPLETE",
        reviewItems,
    };
}

/**
 * Read-only shipment operational summary. ACL enforced first.
 */
export async function buildShipmentOperationalSummary(
    actor: OperationalActor,
    shipmentLeadId: string
): Promise<ShipmentOperationalSummary> {
    let id = String(shipmentLeadId || "").trim();
    if (!id.includes("-") || id.length < 30) {
        const byNumber = await prisma.shipmentLead.findFirst({
            where: {
                OR: [
                    { loadNumber: id },
                    { greenOsShipmentId: id },
                    { externalShipmentId: id },
                ],
            },
            select: { shipmentLeadId: true },
        });
        if (byNumber) id = byNumber.shipmentLeadId;
    }

    await assertShipmentAccessOrThrow(actor, id);

    const incompleteContext: string[] = [];

    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: id },
        select: {
            shipmentLeadId: true,
            loadNumber: true,
            greenOsShipmentId: true,
            status: true,
            customerName: true,
            customerEmail: true,
            carrierName: true,
            carrierMc: true,
            carrierDot: true,
            carrierProfileId: true,
            pickupCity: true,
            pickupState: true,
            deliveryCity: true,
            deliveryState: true,
            pickupFrom: true,
            deliveryFrom: true,
            commodity: true,
            equipment: true,
            customerRate: true,
            carrierRate: true,
            miles: true,
            trackingStatus: true,
            updatedAt: true,
        },
    });
    if (!lead) throw Object.assign(new Error("Shipment not found"), { status: 404 });

    let carrier: Record<string, unknown> | null = null;
    if (lead.carrierProfileId) {
        const c = await prisma.carrier.findUnique({
            where: { carrierId: lead.carrierProfileId },
            select: {
                carrierId: true,
                legalName: true,
                mcNumber: true,
                dotNumber: true,
                status: true,
                onboardingStatus: true,
            },
        });
        if (c) {
            carrier = {
                carrierId: c.carrierId,
                legalName: c.legalName,
                mcNumber: c.mcNumber,
                dotNumber: c.dotNumber,
                status: c.status,
                onboardingStatus: c.onboardingStatus,
            };
        }
    }

    const loadDocs = await prisma.loadDocument.findMany({
        where: { shipmentLeadId: id, isCurrent: true },
        orderBy: { createdAt: "desc" },
        select: {
            documentId: true,
            docType: true,
            fileName: true,
            title: true,
            status: true,
            createdAt: true,
        },
    });

    // Latest Document AI jobs for load docs
    const jobRows = await prisma.aiDocumentJob.findMany({
        where: {
            shipmentLeadId: id,
            status: { in: ["SUCCEEDED", "CACHED"] },
            validation: { isNot: null },
        },
        orderBy: { completedAt: "desc" },
        take: 30,
        include: {
            validation: true,
            extraction: { select: { signaturesJson: true, fields: true } },
        },
    });
    const jobByDoc = new Map<string, (typeof jobRows)[0]>();
    for (const j of jobRows) {
        if (!jobByDoc.has(j.documentId)) jobByDoc.set(j.documentId, j);
    }

    const checklist: DocumentChecklistItem[] = SHIPMENT_DOC_SLOTS.map((slot) => {
        const doc = loadDocs.find((d) => (slot.types as readonly string[]).includes(d.docType));
        const job = doc ? jobByDoc.get(doc.documentId) : undefined;
        let sigStatus: string | null = null;
        if (job?.extraction?.signaturesJson) {
            try {
                const arr = JSON.parse(job.extraction.signaturesJson) as Array<{
                    status?: string;
                    role?: string;
                }>;
                sigStatus = arr.map((s) => `${s.role}:${s.status}`).join(", ");
            } catch {
                /* ignore */
            }
        }
        const status = mapLoadDocStatus(
            Boolean(doc),
            job?.validation?.overallStatus || null,
            sigStatus
        );
        let reason = "No current load document";
        if (doc && !job) reason = "Document present; Document AI validation not available yet";
        if (doc && job) reason = `Validation: ${job.validation?.overallStatus || "unknown"}`;
        if (sigStatus?.includes("MISSING") || sigStatus?.includes("UNCERTAIN")) {
            reason = `Signature: ${sigStatus}`;
        }
        return {
            documentType: slot.types[0],
            slot: slot.slot,
            status,
            validationStatus: job?.validation?.overallStatus || null,
            trafficLight: job?.validation?.trafficLight || null,
            expiration: null,
            signatureStatus: sigStatus,
            reason,
            documentId: doc?.documentId || null,
        };
    });

    // Cross-check load number / MC vs shipment
    const warnings: string[] = [];
    for (const j of jobRows) {
        const fields = j.extraction?.fields || [];
        const loadField = fields.find((f) => f.fieldKey === "loadNumber" || f.fieldKey === "bolNumber");
        if (loadField && lead.loadNumber) {
            const docLoad = normalizeLoadNumber(loadField.valueNormalized || loadField.valueText);
            const gosLoad = normalizeLoadNumber(lead.loadNumber);
            if (docLoad && gosLoad && docLoad !== gosLoad) {
                warnings.push(
                    `Load/BOL on ${j.classifiedDocType || "document"} (${docLoad}) ≠ ShipmentLead (${gosLoad})`
                );
            }
        }
        const mcField = fields.find((f) => f.fieldKey === "mcNumber" || f.fieldKey === "carrierMc");
        if (mcField && lead.carrierMc) {
            const docMc = normalizeMc(mcField.valueNormalized || mcField.valueText);
            const gosMc = normalizeMc(lead.carrierMc);
            if (docMc && gosMc && docMc !== gosMc) {
                warnings.push(`MC on document (${docMc}) ≠ ShipmentLead (${gosMc}) — CRITICAL_MISMATCH`);
            }
        }
    }

    const { readiness, reviewItems } = deriveShipmentReadiness(checklist, lead.status);

    const recommendations: OperationalRecommendation[] = [];
    for (const item of checklist) {
        if (item.status === "MISSING") {
            recommendations.push(
                recommendation(
                    `ship-miss-${item.slot}`,
                    item.slot === "POD" ? "Ask carrier for signed POD" : `Upload / obtain ${item.slot}`,
                    item.reason,
                    item.slot === "POD" ? "HIGH" : "HIGH",
                    item.documentId || undefined
                )
            );
        } else if (item.status === "REVIEW_REQUIRED") {
            recommendations.push(
                recommendation(
                    `ship-rev-${item.slot}`,
                    item.slot === "POD" ? "Review POD signature / validation" : `Review ${item.slot}`,
                    item.reason,
                    "HIGH",
                    item.documentId || undefined
                )
            );
        }
    }
    for (const w of warnings) {
        if (/CRITICAL_MISMATCH/i.test(w)) {
            recommendations.push(
                recommendation("ship-mc-mismatch", "Review MC discrepancy before closing", w, "CRITICAL", "cross_document")
            );
        }
    }
    if (readiness === "READY_TO_CLOSE") {
        recommendations.push(
            recommendation(
                "ship-ready-close",
                "Shipment appears ready to close — confirm in GreenOS (AI will not close automatically)",
                "POD valid and required load documents present",
                "MEDIUM",
                id
            )
        );
    }

    // Timeline
    const timeline: ShipmentOperationalSummary["timeline"] = [];
    try {
        const [domain, events] = await Promise.all([
            prisma.domainEvent.findMany({
                where: { shipmentLeadId: id },
                orderBy: { createdAt: "asc" },
                take: 40,
                select: { eventId: true, eventType: true, title: true, createdAt: true },
            }),
            prisma.shipmentTimelineEvent.findMany({
                where: { shipmentLeadId: id },
                orderBy: { createdAt: "asc" },
                take: 40,
                select: { eventId: true, stage: true, title: true, createdAt: true },
            }),
        ]);
        for (const e of domain) {
            timeline.push({
                at: e.createdAt.toISOString(),
                title: e.title,
                type: e.eventType,
                id: e.eventId,
            });
        }
        for (const e of events) {
            timeline.push({
                at: e.createdAt.toISOString(),
                title: e.title,
                type: e.stage,
                id: e.eventId,
            });
        }
        timeline.sort((a, b) => a.at.localeCompare(b.at));
    } catch {
        incompleteContext.push("Timeline information could not be retrieved.");
    }

    // Emails (authorized via shipment ACL already)
    const emails: ShipmentOperationalSummary["emails"] = [];
    try {
        const mailbox = await prisma.brokerMailboxMessage.findMany({
            where: {
                shipmentLeadId: id,
                ...(actor.role === "Broker" ? { userId: actor.userId } : {}),
            },
            orderBy: { receivedAt: "desc" },
            take: 10,
            select: {
                messageId: true,
                subject: true,
                fromAddress: true,
                snippet: true,
                receivedAt: true,
            },
        });
        for (const m of mailbox) {
            emails.push({
                id: m.messageId,
                subject: m.subject,
                from: m.fromAddress,
                at: m.receivedAt.toISOString(),
                snippet: (m.snippet || "").slice(0, 160),
            });
        }
        const importer = await prisma.emailMessage.findMany({
            where: { shipmentLeads: { some: { shipmentLeadId: id } } },
            orderBy: { receivedAt: "desc" },
            take: 5,
            select: {
                emailMessageId: true,
                subject: true,
                fromAddress: true,
                snippet: true,
                receivedAt: true,
            },
        });
        for (const m of importer) {
            emails.push({
                id: m.emailMessageId,
                subject: m.subject,
                from: m.fromAddress,
                at: m.receivedAt.toISOString(),
                snippet: (m.snippet || "").slice(0, 160),
            });
        }
    } catch {
        incompleteContext.push("Email information could not be retrieved.");
    }

    let tracking: Record<string, unknown> | null = null;
    try {
        const t = await prisma.shipmentTracking.findFirst({
            where: { shipmentLeadId: id, status: "ACTIVE" },
            select: {
                trackingId: true,
                provider: true,
                status: true,
                lastAddress: true,
                lastPositionAt: true,
                trackingUrl: true,
                driverPhone: true,
            },
        });
        if (t) {
            tracking = {
                trackingId: t.trackingId,
                provider: t.provider,
                status: t.status,
                lastAddress: t.lastAddress,
                lastPositionAt: t.lastPositionAt?.toISOString() || null,
                // omit full phone if sensitive — show last 4 only
                driverPhoneHint: t.driverPhone
                    ? `******${String(t.driverPhone).replace(/\D/g, "").slice(-4)}`
                    : null,
                hasTrackingUrl: Boolean(t.trackingUrl),
            };
        }
    } catch {
        incompleteContext.push("Tracking information could not be retrieved.");
    }

    const sources: OperationalSource[] = [
        {
            type: "shipment",
            id: lead.shipmentLeadId,
            label: lead.loadNumber || lead.greenOsShipmentId || lead.shipmentLeadId,
            shipmentLeadId: lead.shipmentLeadId,
            carrierId: lead.carrierProfileId || undefined,
        },
        ...loadDocs.map((d) => ({
            type: "load_document",
            id: d.documentId,
            label: `${d.docType}: ${d.fileName || d.title}`,
            shipmentLeadId: id,
        })),
        ...emails.slice(0, 5).map((e) => ({
            type: "email",
            id: e.id,
            label: e.subject,
            shipmentLeadId: id,
        })),
        ...timeline.slice(0, 10).map((t) => ({
            type: "timeline",
            id: t.id,
            label: t.title,
            shipmentLeadId: id,
        })),
    ];
    if (carrier?.carrierId) {
        sources.push({
            type: "carrier",
            id: String(carrier.carrierId),
            label: String(carrier.legalName || carrier.carrierId),
            carrierId: String(carrier.carrierId),
            shipmentLeadId: id,
        });
    }

    const nextBestActions = prioritizeRecommendations(recommendations).slice(0, 8);

    return {
        shipment: {
            shipmentLeadId: lead.shipmentLeadId,
            loadNumber: lead.loadNumber,
            greenOsShipmentId: lead.greenOsShipmentId,
            status: lead.status,
            customerName: lead.customerName,
            carrierName: lead.carrierName,
            carrierMc: lead.carrierMc,
            carrierDot: lead.carrierDot,
            origin: [lead.pickupCity, lead.pickupState].filter(Boolean).join(", "),
            destination: [lead.deliveryCity, lead.deliveryState].filter(Boolean).join(", "),
            pickupFrom: lead.pickupFrom?.toISOString() || null,
            deliveryFrom: lead.deliveryFrom?.toISOString() || null,
            commodity: lead.commodity,
            equipment: lead.equipment,
            customerRate: lead.customerRate,
            carrierRate: lead.carrierRate,
            miles: lead.miles,
            trackingStatus: lead.trackingStatus,
            updatedAt: lead.updatedAt.toISOString(),
        },
        carrier,
        readiness,
        documents: checklist,
        timeline,
        emails,
        tracking,
        missingDocuments: checklist.filter((d) => d.status === "MISSING").map((d) => d.slot),
        reviewItems: [...new Set(reviewItems)],
        warnings: [...new Set(warnings)],
        recommendations: nextBestActions,
        nextBestActions,
        sources,
        answerMode: "OPERATIONAL",
        groundingLabel: "Based on GreenOS data",
        incompleteContext,
    };
}

export function _deriveShipmentReadinessForTests(
    checklist: DocumentChecklistItem[],
    status: string
) {
    return deriveShipmentReadiness(checklist, status);
}

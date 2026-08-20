import { prisma } from "../../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import { extractMcDigits, mcSearchVariants } from "./ai-mc-normalize.js";

export type AiActor = { userId: string; role: string };

export type AiSource = {
    type: string;
    id: string;
    label: string;
    carrierId?: string;
    shipmentLeadId?: string;
};

export type AiToolResult = {
    ok: boolean;
    tool: string;
    code?: string;
    message?: string;
    data?: Record<string, unknown> | Array<Record<string, unknown>> | null;
    sources: AiSource[];
};

function notFound(tool: string): AiToolResult {
    return {
        ok: false,
        tool,
        code: "NOT_FOUND",
        message: "I could not find this information in GreenOS.",
        data: null,
        sources: [],
    };
}

function forbidden(tool: string): AiToolResult {
    return {
        ok: false,
        tool,
        code: "FORBIDDEN",
        message: "Access denied.",
        data: null,
        sources: [],
    };
}

/**
 * READ-ONLY tools. Every call enforces the same ACL as GreenOS UI/API.
 */
export class AiTools {
    async getCarrierById(actor: AiActor, carrierId: string): Promise<AiToolResult> {
        const id = String(carrierId || "").trim();
        if (!id) return notFound("getCarrierById");
        try {
            await carrierService.assertCarrierAccess(id, actor);
        } catch (err) {
            const status =
                err && typeof err === "object" && "status" in err
                    ? Number((err as { status: number }).status)
                    : 500;
            if (status === 404) return notFound("getCarrierById");
            if (status === 403) return forbidden("getCarrierById");
            throw err;
        }

        const row = await prisma.carrier.findUnique({
            where: { carrierId: id },
            select: {
                carrierId: true,
                legalName: true,
                dbaName: true,
                email: true,
                phone: true,
                mcNumber: true,
                dotNumber: true,
                city: true,
                state: true,
                status: true,
                onboardingStatus: true,
                assignedBrokerId: true,
                updatedAt: true,
            },
        });
        if (!row) return notFound("getCarrierById");

        return {
            ok: true,
            tool: "getCarrierById",
            data: {
                carrierId: row.carrierId,
                legalName: row.legalName,
                dbaName: row.dbaName,
                email: row.email,
                phone: row.phone,
                mcNumber: row.mcNumber,
                dotNumber: row.dotNumber,
                city: row.city,
                state: row.state,
                status: row.status,
                onboardingStatus: row.onboardingStatus,
                assignedBrokerId: row.assignedBrokerId,
                updatedAt: row.updatedAt.toISOString(),
            },
            sources: [
                {
                    type: "carrier",
                    id: row.carrierId,
                    label: row.legalName,
                    carrierId: row.carrierId,
                },
            ],
        };
    }

    /**
     * Extra Phase-1 read-only tool: resolve carrier by name/MC/DOT under ACL.
     * Needed so natural-language questions can find real records.
     *
     * MC lookups normalize common prefixes (MC / MC- / spaces) so a DB value
     * like "1234545" matches queries such as "MC1234545". ACL still applies.
     */
    async findCarriers(actor: AiActor, query: string): Promise<AiToolResult> {
        const q = String(query || "").trim();
        if (!q || q.length < 2) return notFound("findCarriers");

        const mcDigits = extractMcDigits(q);
        let rows: Awaited<ReturnType<typeof carrierService.list>> = [];

        if (mcDigits) {
            // Narrow MC search: match stored mc_number against digit / prefixed variants.
            const where: Record<string, unknown> = {
                OR: mcSearchVariants(q).flatMap((v) => [
                    { mcNumber: { equals: v } },
                    { mcNumber: { contains: v } },
                ]),
            };
            if (actor.role === "Broker") where.assignedBrokerId = actor.userId;
            rows = await prisma.carrier.findMany({
                where,
                orderBy: { updatedAt: "desc" },
                include: {
                    assignedBroker: {
                        select: { userId: true, firstName: true, lastName: true, email: true },
                    },
                },
                take: 20,
            });
            // Prefer exact digit match when multiple fuzzy contains hits.
            rows = rows
                .filter((r) => {
                    const stored = String(r.mcNumber || "").replace(/^MC[#\s-]*/i, "").trim();
                    return stored === mcDigits || String(r.mcNumber || "").includes(mcDigits);
                })
                .sort((a, b) => {
                    const aExact =
                        String(a.mcNumber || "").replace(/^MC[#\s-]*/i, "").trim() === mcDigits
                            ? 0
                            : 1;
                    const bExact =
                        String(b.mcNumber || "").replace(/^MC[#\s-]*/i, "").trim() === mcDigits
                            ? 0
                            : 1;
                    return aExact - bExact;
                });
        } else {
            rows = await carrierService.list(actor, { q });
        }

        if (!rows.length) return notFound("findCarriers");

        const slim = rows.slice(0, 5).map((r) => ({
            carrierId: r.carrierId,
            legalName: r.legalName,
            dbaName: r.dbaName,
            mcNumber: r.mcNumber,
            dotNumber: r.dotNumber,
            onboardingStatus: r.onboardingStatus,
            status: r.status,
            city: r.city,
            state: r.state,
        }));

        return {
            ok: true,
            tool: "findCarriers",
            data: slim,
            sources: slim.map((r) => ({
                type: "carrier",
                id: r.carrierId,
                label: r.legalName,
                carrierId: r.carrierId,
            })),
        };
    }

    async getShipmentById(actor: AiActor, shipmentLeadId: string): Promise<AiToolResult> {
        let id = String(shipmentLeadId || "").trim();
        if (!id) return notFound("getShipmentById");

        // Allow load number / GOS number lookup, then ACL on resolved id.
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

        try {
            await assertShipmentAccessOrThrow(actor, id);
        } catch (err) {
            const status =
                err && typeof err === "object" && "status" in err
                    ? Number((err as { status: number }).status)
                    : 500;
            if (status === 404) return notFound("getShipmentById");
            if (status === 403) return forbidden("getShipmentById");
            throw err;
        }

        const row = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: id },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                externalShipmentId: true,
                status: true,
                customerName: true,
                carrierName: true,
                carrierMc: true,
                carrierDot: true,
                pickupCity: true,
                pickupState: true,
                deliveryCity: true,
                deliveryState: true,
                equipment: true,
                miles: true,
                assignedBrokerId: true,
                carrierProfileId: true,
                updatedAt: true,
            },
        });
        if (!row) return notFound("getShipmentById");

        return {
            ok: true,
            tool: "getShipmentById",
            data: {
                shipmentLeadId: row.shipmentLeadId,
                loadNumber: row.loadNumber,
                greenOsShipmentId: row.greenOsShipmentId,
                externalShipmentId: row.externalShipmentId,
                status: row.status,
                customerName: row.customerName,
                carrierName: row.carrierName,
                carrierMc: row.carrierMc,
                carrierDot: row.carrierDot,
                pickup: [row.pickupCity, row.pickupState].filter(Boolean).join(", "),
                delivery: [row.deliveryCity, row.deliveryState].filter(Boolean).join(", "),
                equipment: row.equipment,
                miles: row.miles,
                carrierProfileId: row.carrierProfileId,
                assignedBrokerId: row.assignedBrokerId,
                updatedAt: row.updatedAt.toISOString(),
            },
            sources: [
                {
                    type: "shipment",
                    id: row.shipmentLeadId,
                    label: row.loadNumber || row.greenOsShipmentId || row.shipmentLeadId,
                    shipmentLeadId: row.shipmentLeadId,
                    carrierId: row.carrierProfileId || undefined,
                },
            ],
        };
    }

    async listCarrierDocuments(actor: AiActor, carrierId: string): Promise<AiToolResult> {
        const id = String(carrierId || "").trim();
        if (!id) return notFound("listCarrierDocuments");
        try {
            await carrierService.assertCarrierAccess(id, actor);
        } catch (err) {
            const status =
                err && typeof err === "object" && "status" in err
                    ? Number((err as { status: number }).status)
                    : 500;
            if (status === 404) return notFound("listCarrierDocuments");
            if (status === 403) return forbidden("listCarrierDocuments");
            throw err;
        }

        const docs = await prisma.carrierDocument.findMany({
            where: { carrierId: id, status: "CURRENT" },
            orderBy: [{ documentType: "asc" }, { version: "desc" }],
            select: {
                documentId: true,
                documentType: true,
                originalFilename: true,
                version: true,
                status: true,
                uploadedAt: true,
                uploadedBy: true,
            },
        });

        if (!docs.length) {
            return {
                ok: false,
                tool: "listCarrierDocuments",
                code: "NOT_FOUND",
                message: "I could not find this information in GreenOS.",
                data: [],
                sources: [],
            };
        }

        const data = docs.map((d) => ({
            documentId: d.documentId,
            documentType: d.documentType,
            originalFilename: d.originalFilename,
            version: d.version,
            status: d.status,
            uploadedAt: d.uploadedAt.toISOString(),
            uploadedBy: d.uploadedBy,
        }));

        return {
            ok: true,
            tool: "listCarrierDocuments",
            data,
            sources: data.map((d) => ({
                type: "carrier_document",
                id: d.documentId,
                label: d.documentType,
                carrierId: id,
            })),
        };
    }
}

export const aiTools = new AiTools();

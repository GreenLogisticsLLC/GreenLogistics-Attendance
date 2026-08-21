import { prisma } from "../../../config/database.js";
import { assertShipmentAccessOrThrow } from "../../../auth/access.js";
import { carrierService } from "../../carriers/services/carrier.service.js";
import { extractMcDigits, mcSearchVariants } from "../services/ai-mc-normalize.js";
import { normalizeDot, normalizeMc } from "../documents/normalize.js";
import type { KnowledgeSearchProvider } from "./provider.js";
import { SCORE, clampScore } from "./scoring.js";
import type {
    KnowledgeEntityType,
    KnowledgeSearchActor,
    KnowledgeSearchFilters,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeSearchResult,
    KnowledgeSearchSource,
} from "./types.js";

function isBroker(actor: KnowledgeSearchActor): boolean {
    return actor.role === "Broker";
}

function parseEntityTypes(filters?: KnowledgeSearchFilters): Set<KnowledgeEntityType> | null {
    if (!filters?.entityType) return null;
    const arr = Array.isArray(filters.entityType) ? filters.entityType : [filters.entityType];
    return new Set(arr);
}

function monthBounds(d = new Date()): { from: Date; to: Date } {
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from, to };
}

function parseUsDate(s: string | null | undefined): Date | null {
    if (!s) return null;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
        return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    }
    const iso = Date.parse(String(s));
    return Number.isFinite(iso) ? new Date(iso) : null;
}

function snippetOf(...parts: Array<string | null | undefined>): string {
    return parts.filter(Boolean).join(" · ").slice(0, 240);
}

function toSources(results: KnowledgeSearchResult[]): KnowledgeSearchSource[] {
    const out: KnowledgeSearchSource[] = [];
    const seen = new Set<string>();
    for (const r of results) {
        const key = `${r.type}:${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            type: String(r.metadata.sourceType || r.type).toLowerCase(),
            id: r.id,
            label: r.title,
            carrierId: r.metadata.carrierId ? String(r.metadata.carrierId) : undefined,
            shipmentLeadId: r.metadata.shipmentLeadId
                ? String(r.metadata.shipmentLeadId)
                : undefined,
        });
    }
    return out;
}

/**
 * Structured (non-embedding) GreenOS knowledge search.
 * ACL is applied in backend before results leave this provider.
 */
export class StructuredKnowledgeSearchProvider implements KnowledgeSearchProvider {
    readonly name = "StructuredKnowledgeSearchProvider";

    async search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
        const query = String(input.query || "").trim();
        const filters = input.filters || {};
        const limit = Math.min(Math.max(input.limit || 25, 1), 50);
        const actor = input.actor;
        const types = parseEntityTypes(filters);
        const hint = String(filters.intentHint || "").toLowerCase();

        const results: KnowledgeSearchResult[] = [];

        const want = (t: KnowledgeEntityType) => !types || types.has(t);

        // Intent-specific: avoid scanning every store.
        const compliance =
            hint.includes("compliance") ||
            /expir|missing\s+w-?9|below\s*\$?100|cargo\s+insurance|compliant/i.test(query);
        const emailOnly = hint.includes("email") || /\b(email|emailed|mailbox|customer\s+say)\b/i.test(query);
        const timelineOnly =
            hint.includes("timeline") || /\b(happened|timeline|yesterday|history|events?)\b/i.test(query);
        const multi =
            hint.includes("greenos") ||
            hint.includes("general_greenos") ||
            /\b(everything|all\s+about|find\s+everything)\b/i.test(query);

        if (compliance && want("EXTRACTION")) {
            results.push(...(await this.searchCompliance(actor, query, filters)));
        }

        if ((!emailOnly && !timelineOnly) || multi || compliance) {
            if (want("CARRIER")) results.push(...(await this.searchCarriers(actor, query, filters)));
            if (want("SHIPMENT")) results.push(...(await this.searchShipments(actor, query, filters)));
            if (want("DOCUMENT")) results.push(...(await this.searchDocuments(actor, query, filters)));
            if (want("EXTRACTION") && !compliance) {
                results.push(...(await this.searchExtractions(actor, query, filters)));
            }
        }

        if ((emailOnly || multi || hint.includes("email")) && want("EMAIL")) {
            results.push(...(await this.searchEmails(actor, query, filters)));
        }

        if ((timelineOnly || multi || hint.includes("timeline")) && want("TIMELINE")) {
            results.push(...(await this.searchTimeline(actor, query, filters)));
        }

        // Cross-document MC Authority vs COI when asked
        if (/\b(match|mismatch|authority).{0,40}\b(coi|insurance)\b|\b(coi|insurance).{0,40}\b(authority|mc)\b/i.test(query)) {
            results.push(...(await this.compareAuthorityVsCoi(actor, query, filters)));
        }

        results.sort((a, b) => b.score - a.score);
        const trimmed = results.slice(0, limit);
        return {
            results: trimmed,
            sources: toSources(trimmed),
            searchMode: "STRUCTURED",
            resultCount: trimmed.length,
        };
    }

    private async searchCarriers(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const mc = normalizeMc(filters.mc || extractMcDigits(query) || "");
        const dot = normalizeDot(filters.dot || query.match(/\bDOT[#\s-]*([0-9]{4,})\b/i)?.[1] || "");
        const q = query.trim();
        if (filters.carrierId) {
            try {
                await carrierService.assertCarrierAccess(filters.carrierId, actor);
            } catch {
                return [];
            }
            const row = await prisma.carrier.findUnique({
                where: { carrierId: filters.carrierId },
                select: {
                    carrierId: true,
                    legalName: true,
                    dbaName: true,
                    mcNumber: true,
                    dotNumber: true,
                    email: true,
                    phone: true,
                    city: true,
                    state: true,
                    status: true,
                    onboardingStatus: true,
                },
            });
            if (!row) return [];
            return [
                {
                    type: "CARRIER",
                    id: row.carrierId,
                    title: row.legalName,
                    snippet: snippetOf(row.mcNumber && `MC ${row.mcNumber}`, row.dotNumber && `DOT ${row.dotNumber}`, row.status),
                    matchedFields: ["carrierId"],
                    score: SCORE.EXACT_ID,
                    metadata: { ...row, sourceType: "carrier", carrierId: row.carrierId },
                },
            ];
        }

        if (!q && !mc && !dot) return [];

        let rows: Array<{
            carrierId: string;
            legalName: string;
            dbaName: string | null;
            mcNumber: string | null;
            dotNumber: string | null;
            email: string;
            phone: string | null;
            city: string | null;
            state: string | null;
            status: string;
            onboardingStatus: string;
            address: string | null;
        }> = [];

        if (mc) {
            const where: Record<string, unknown> = {
                OR: mcSearchVariants(mc).flatMap((v) => [
                    { mcNumber: { equals: v } },
                    { mcNumber: { contains: v } },
                ]),
            };
            if (isBroker(actor)) where.assignedBrokerId = actor.userId;
            rows = await prisma.carrier.findMany({
                where,
                take: 20,
                orderBy: { updatedAt: "desc" },
                select: {
                    carrierId: true,
                    legalName: true,
                    dbaName: true,
                    mcNumber: true,
                    dotNumber: true,
                    email: true,
                    phone: true,
                    city: true,
                    state: true,
                    status: true,
                    onboardingStatus: true,
                    address: true,
                },
            });
            rows = rows.filter((r) => normalizeMc(r.mcNumber) === mc);
        } else if (dot) {
            const where: Record<string, unknown> = {
                OR: [{ dotNumber: { equals: dot } }, { dotNumber: { contains: dot } }],
            };
            if (isBroker(actor)) where.assignedBrokerId = actor.userId;
            rows = await prisma.carrier.findMany({
                where,
                take: 20,
                orderBy: { updatedAt: "desc" },
                select: {
                    carrierId: true,
                    legalName: true,
                    dbaName: true,
                    mcNumber: true,
                    dotNumber: true,
                    email: true,
                    phone: true,
                    city: true,
                    state: true,
                    status: true,
                    onboardingStatus: true,
                    address: true,
                },
            });
            rows = rows.filter((r) => normalizeDot(r.dotNumber) === dot);
        } else {
            const listed = await carrierService.list(actor, { q: q.slice(0, 80) });
            rows = listed.slice(0, 15).map((r) => ({
                carrierId: r.carrierId,
                legalName: r.legalName,
                dbaName: r.dbaName,
                mcNumber: r.mcNumber,
                dotNumber: r.dotNumber,
                email: r.email,
                phone: r.phone,
                city: r.city,
                state: r.state,
                status: r.status,
                onboardingStatus: r.onboardingStatus,
                address: r.address,
            }));
        }

        return rows.map((row) => {
            const matched: string[] = [];
            let score: number = SCORE.KEYWORD;
            if (mc && normalizeMc(row.mcNumber) === mc) {
                matched.push("mcNumber");
                score = SCORE.EXACT_MC_DOT_LOAD;
            }
            if (dot && normalizeDot(row.dotNumber) === dot) {
                matched.push("dotNumber");
                score = Math.max(score, SCORE.EXACT_MC_DOT_LOAD);
            }
            const nameQ = q.toLowerCase();
            if (row.legalName.toLowerCase().includes(nameQ) || (row.dbaName || "").toLowerCase().includes(nameQ)) {
                matched.push(row.legalName.toLowerCase() === nameQ ? "legalName" : "name");
                score = Math.max(score, row.legalName.toLowerCase() === nameQ ? SCORE.EXACT_NAME : SCORE.KEYWORD);
            }
            if (row.email && nameQ && row.email.toLowerCase().includes(nameQ)) matched.push("email");
            if (row.phone && q.replace(/\D/g, "") && String(row.phone).includes(q.replace(/\D/g, ""))) {
                matched.push("phone");
            }
            if (!matched.length) matched.push("keyword");
            return {
                type: "CARRIER" as const,
                id: row.carrierId,
                title: row.legalName,
                snippet: snippetOf(
                    row.dbaName && `DBA ${row.dbaName}`,
                    row.mcNumber && `MC ${row.mcNumber}`,
                    row.dotNumber && `DOT ${row.dotNumber}`,
                    [row.city, row.state].filter(Boolean).join(", "),
                    row.status
                ),
                matchedFields: matched,
                score: clampScore(score),
                metadata: {
                    sourceType: "carrier",
                    carrierId: row.carrierId,
                    legalName: row.legalName,
                    dbaName: row.dbaName,
                    mcNumber: row.mcNumber,
                    dotNumber: row.dotNumber,
                    email: row.email,
                    phone: row.phone,
                    status: row.status,
                    onboardingStatus: row.onboardingStatus,
                },
            };
        });
    }

    private async searchShipments(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const load =
            filters.loadNumber ||
            query.match(/\b(GL\d{4,}|GOS\d{4,}|\d{4,6})\b/i)?.[1] ||
            null;
        const mc = normalizeMc(filters.mc || extractMcDigits(query) || "");
        const status = filters.status || null;
        const shipmentId = filters.shipmentId || null;

        const where: Record<string, unknown> = {};
        if (isBroker(actor)) where.assignedBrokerId = actor.userId;
        if (shipmentId) where.shipmentLeadId = shipmentId;
        if (filters.carrierId) where.carrierProfileId = filters.carrierId;
        if (status) where.status = status;

        const or: Record<string, unknown>[] = [];
        if (load) {
            or.push(
                { loadNumber: { equals: load } },
                { loadNumber: { contains: load } },
                { greenOsShipmentId: { equals: load } },
                { externalShipmentId: { equals: load } },
                { referenceNumber: { contains: load } }
            );
        }
        if (mc) {
            or.push({ carrierMc: { contains: mc } });
        }
        const q = query.trim();
        if (q.length >= 3 && !load && !mc) {
            or.push(
                { customerName: { contains: q } },
                { carrierName: { contains: q } },
                { shipmentTitle: { contains: q } },
                { commodity: { contains: q } },
                { pickupCity: { contains: q } },
                { deliveryCity: { contains: q } }
            );
        }
        if (or.length) where.OR = or;
        else if (!shipmentId && !filters.carrierId && !status) return [];

        const rows = await prisma.shipmentLead.findMany({
            where,
            take: 20,
            orderBy: { updatedAt: "desc" },
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                status: true,
                customerName: true,
                carrierName: true,
                carrierMc: true,
                carrierDot: true,
                pickupCity: true,
                pickupState: true,
                deliveryCity: true,
                deliveryState: true,
                commodity: true,
                carrierProfileId: true,
                assignedBrokerId: true,
                pickupFrom: true,
                deliveryFrom: true,
            },
        });

        const out: KnowledgeSearchResult[] = [];
        for (const row of rows) {
            try {
                await assertShipmentAccessOrThrow(actor, row.shipmentLeadId);
            } catch {
                continue;
            }
            const matched: string[] = [];
            let score: number = SCORE.KEYWORD;
            if (load && (row.loadNumber === load || row.greenOsShipmentId === load)) {
                matched.push("loadNumber");
                score = SCORE.EXACT_MC_DOT_LOAD;
            }
            if (mc && normalizeMc(row.carrierMc) === mc) {
                matched.push("carrierMc");
                score = Math.max(score, SCORE.EXACT_MC_DOT_LOAD);
            }
            if (!matched.length) matched.push("keyword");
            out.push({
                type: "SHIPMENT",
                id: row.shipmentLeadId,
                title: row.loadNumber || row.greenOsShipmentId || row.shipmentLeadId,
                snippet: snippetOf(
                    row.status,
                    row.carrierName,
                    row.customerName,
                    [row.pickupCity, row.pickupState].filter(Boolean).join(", "),
                    "→",
                    [row.deliveryCity, row.deliveryState].filter(Boolean).join(", "),
                    row.commodity
                ),
                matchedFields: matched,
                score: clampScore(score),
                metadata: {
                    sourceType: "shipment",
                    shipmentLeadId: row.shipmentLeadId,
                    carrierId: row.carrierProfileId || undefined,
                    loadNumber: row.loadNumber,
                    status: row.status,
                    customerName: row.customerName,
                    carrierName: row.carrierName,
                    carrierMc: row.carrierMc,
                    carrierDot: row.carrierDot,
                    pickupFrom: row.pickupFrom?.toISOString() || null,
                    deliveryFrom: row.deliveryFrom?.toISOString() || null,
                },
            });
        }
        return out;
    }

    private async searchDocuments(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const docType =
            filters.documentType ||
            query.match(
                /\b(W-?9|COI|INSURANCE|MC_AUTHORITY|MC\s*AUTHORITY|NOA|BOL|POD|RATE_CONFIRMATION|AGREEMENT)\b/i
            )?.[1];
        const normalizedType = docType
            ? String(docType)
                  .toUpperCase()
                  .replace(/\s+/g, "_")
                  .replace("W-9", "W9")
                  .replace("MC_AUTHORITY", "MC_AUTHORITY")
                  .replace("MC AUTHORITY", "MC_AUTHORITY")
            : null;

        const carrierFilter = filters.carrierId || null;
        const shipmentFilter = filters.shipmentId || null;
        const q = query.trim();

        const carrierWhere: Record<string, unknown> = { status: "CURRENT" };
        if (carrierFilter) carrierWhere.carrierId = carrierFilter;
        if (shipmentFilter) carrierWhere.shipmentLeadId = shipmentFilter;
        if (isBroker(actor) && !carrierFilter) {
            carrierWhere.carrier = { assignedBrokerId: actor.userId };
        }
        if (normalizedType) {
            const typeOr: Array<{ documentType: string }> = [{ documentType: normalizedType }];
            if (normalizedType === "COI" || normalizedType === "INSURANCE") {
                typeOr.push({ documentType: "COI" }, { documentType: "INSURANCE" });
            }
            if (normalizedType.includes("MC")) typeOr.push({ documentType: "MC_AUTHORITY" });
            if (normalizedType === "AGREEMENT" || normalizedType === "BROKER_CARRIER_AGREEMENT") {
                typeOr.push({ documentType: "BROKER_CARRIER_AGREEMENT" });
            }
            carrierWhere.OR = typeOr;
        }
        if (q.length >= 3 && !normalizedType) {
            carrierWhere.OR = [
                { originalFilename: { contains: q } },
                { documentType: { contains: q.slice(0, 40) } },
            ];
        } else if (q.length >= 3 && normalizedType) {
            carrierWhere.AND = [{ originalFilename: { contains: q } }];
        }

        const docs = await prisma.carrierDocument.findMany({
            where: carrierWhere,
            take: 30,
            orderBy: { uploadedAt: "desc" },
            select: {
                documentId: true,
                carrierId: true,
                shipmentLeadId: true,
                documentType: true,
                originalFilename: true,
                status: true,
                uploadedAt: true,
                version: true,
                carrier: { select: { legalName: true, assignedBrokerId: true } },
            },
        });

        const out: KnowledgeSearchResult[] = [];
        for (const d of docs) {
            try {
                await carrierService.assertCarrierAccess(d.carrierId, actor);
            } catch {
                continue;
            }
            if (d.shipmentLeadId) {
                try {
                    await assertShipmentAccessOrThrow(actor, d.shipmentLeadId);
                } catch {
                    continue;
                }
            }
            const matched: string[] = [];
            let score: number = SCORE.FILENAME;
            if (normalizedType && d.documentType.toUpperCase().includes(normalizedType.replace("_", ""))) {
                matched.push("documentType");
                score = SCORE.EXACT_FIELD;
            }
            if (q && d.originalFilename.toLowerCase().includes(q.toLowerCase())) {
                matched.push("filename");
            }
            if (!matched.length) matched.push("document");
            out.push({
                type: "DOCUMENT",
                id: d.documentId,
                title: `${d.documentType}: ${d.originalFilename}`,
                snippet: snippetOf(d.carrier.legalName, d.status, `v${d.version}`, d.uploadedAt.toISOString().slice(0, 10)),
                matchedFields: matched,
                score: clampScore(score),
                metadata: {
                    sourceType: "carrier_document",
                    carrierId: d.carrierId,
                    shipmentLeadId: d.shipmentLeadId || undefined,
                    documentType: d.documentType,
                    originalFilename: d.originalFilename,
                    status: d.status,
                    uploadedAt: d.uploadedAt.toISOString(),
                },
            });
        }

        // Load documents when shipment scoped or load number in query
        if (shipmentFilter || filters.loadNumber || /\b(bol|pod|rate\s*con|load\s+doc)/i.test(query)) {
            const loadDocs = await this.searchLoadDocuments(actor, query, filters);
            out.push(...loadDocs);
        }

        return out;
    }

    private async searchLoadDocuments(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        let shipmentLeadId = filters.shipmentId || null;
        if (!shipmentLeadId && filters.loadNumber) {
            const lead = await prisma.shipmentLead.findFirst({
                where: { loadNumber: filters.loadNumber },
                select: { shipmentLeadId: true },
            });
            shipmentLeadId = lead?.shipmentLeadId || null;
        }
        if (!shipmentLeadId) {
            const load = query.match(/\b(GL\d{4,}|\d{4,6})\b/i)?.[1];
            if (load) {
                const lead = await prisma.shipmentLead.findFirst({
                    where: {
                        OR: [{ loadNumber: load }, { loadNumber: { contains: load } }],
                    },
                    select: { shipmentLeadId: true },
                });
                shipmentLeadId = lead?.shipmentLeadId || null;
            }
        }
        if (!shipmentLeadId) return [];
        try {
            await assertShipmentAccessOrThrow(actor, shipmentLeadId);
        } catch {
            return [];
        }

        const docs = await prisma.loadDocument.findMany({
            where: { shipmentLeadId, isCurrent: true },
            take: 20,
            orderBy: { createdAt: "desc" },
            select: {
                documentId: true,
                shipmentLeadId: true,
                docType: true,
                fileName: true,
                title: true,
                createdAt: true,
            },
        });

        return docs.map((d) => ({
            type: "DOCUMENT" as const,
            id: d.documentId,
            title: `${d.docType}: ${d.fileName || d.title || d.documentId}`,
            snippet: snippetOf(d.docType, d.createdAt.toISOString().slice(0, 10)),
            matchedFields: ["load_document"],
            score: SCORE.EXACT_FIELD,
            metadata: {
                sourceType: "load_document",
                shipmentLeadId: d.shipmentLeadId,
                documentType: d.docType,
                originalFilename: d.fileName || d.title,
            },
        }));
    }

    private async searchExtractions(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const mc = normalizeMc(filters.mc || extractMcDigits(query) || "");
        const load = filters.loadNumber || query.match(/\b(GL\d{4,}|\d{4,6})\b/i)?.[1];
        const fieldHints: string[] = [];
        if (/expir/i.test(query)) fieldHints.push("policyExp", "expirationDate");
        if (/cargo/i.test(query)) fieldHints.push("cargoLimit");
        if (/auto\s*liab/i.test(query)) fieldHints.push("autoLiabilityLimit");
        if (/holder/i.test(query)) fieldHints.push("certificateHolder");
        if (/rate/i.test(query)) fieldHints.push("flatRate", "rate");
        if (/w-?9|taxpayer|ein/i.test(query)) fieldHints.push("name", "businessName", "taxClassification", "tin");
        if (/signature/i.test(query)) fieldHints.push("signatureStatus");

        const where: Record<string, unknown> = {
            job: {
                status: { in: ["SUCCEEDED", "CACHED"] },
                ...(filters.carrierId ? { carrierId: filters.carrierId } : {}),
                ...(filters.shipmentId ? { shipmentLeadId: filters.shipmentId } : {}),
            },
        };

        // Search fields
        const fieldOr: Record<string, unknown>[] = [];
        if (mc) {
            fieldOr.push(
                { fieldKey: { in: ["mcNumber", "carrierMc"] }, valueNormalized: mc },
                { fieldKey: { in: ["mcNumber", "carrierMc"] }, valueText: { contains: mc } }
            );
        }
        if (load) {
            fieldOr.push(
                { fieldKey: { in: ["loadNumber", "bolNumber"] }, valueNormalized: load },
                { fieldKey: { in: ["loadNumber", "bolNumber"] }, valueText: { contains: load } }
            );
        }
        if (fieldHints.length) {
            fieldOr.push({ fieldKey: { in: fieldHints } });
        }
        if (query.length >= 4 && !mc && !load && !fieldHints.length) {
            fieldOr.push({ valueText: { contains: query.slice(0, 60) } });
        }
        if (!fieldOr.length && !filters.carrierId) return [];

        const fields = await prisma.documentExtractionField.findMany({
            where: {
                ...(fieldOr.length ? { OR: fieldOr } : {}),
                extraction: where,
            },
            take: 40,
            include: {
                extraction: {
                    include: {
                        job: {
                            include: { validation: true },
                        },
                    },
                },
            },
        });

        const byJob = new Map<string, KnowledgeSearchResult>();
        for (const f of fields) {
            const job = f.extraction.job;
            const carrierId = job.carrierId;
            if (carrierId) {
                try {
                    await carrierService.assertCarrierAccess(carrierId, actor);
                } catch {
                    continue;
                }
            } else if (job.shipmentLeadId) {
                try {
                    await assertShipmentAccessOrThrow(actor, job.shipmentLeadId);
                } catch {
                    continue;
                }
            } else if (isBroker(actor)) {
                continue;
            }

            const existing = byJob.get(job.jobId);
            const matched = existing?.matchedFields.slice() || [];
            if (!matched.includes(f.fieldKey)) matched.push(f.fieldKey);
            const score =
                f.fieldKey.includes("mc") || f.fieldKey.includes("load")
                    ? SCORE.EXACT_FIELD
                    : SCORE.KEYWORD;
            byJob.set(job.jobId, {
                type: "EXTRACTION",
                id: f.extraction.extractionId,
                title: `${f.extraction.documentType} extraction`,
                snippet: snippetOf(
                    `${f.fieldKey}=${f.valueNormalized || f.valueText || ""}`,
                    job.validation?.overallStatus,
                    job.validation?.trafficLight
                ),
                matchedFields: matched,
                score: clampScore(Math.max(existing?.score || 0, score)),
                metadata: {
                    sourceType: "document_extraction",
                    carrierId: carrierId || undefined,
                    shipmentLeadId: job.shipmentLeadId || undefined,
                    documentId: job.documentId,
                    documentType: f.extraction.documentType,
                    validationStatus: job.validation?.overallStatus || null,
                    trafficLight: job.validation?.trafficLight || null,
                    fields: {
                        ...(typeof existing?.metadata.fields === "object" && existing.metadata.fields
                            ? (existing.metadata.fields as Record<string, string | null>)
                            : {}),
                        [f.fieldKey]: f.valueNormalized || f.valueText,
                    },
                },
            });
        }
        return [...byJob.values()];
    }

    private async searchCompliance(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const out: KnowledgeSearchResult[] = [];
        const { from, to } = monthBounds();
        const wantsExpiring =
            /expir/i.test(query) || /this\s+month|soon/i.test(query);
        const wantsExpired = /expired/i.test(query);
        const wantsMissingW9 = /missing\s+w-?9|no\s+w-?9/i.test(query);
        const wantsLowCargo = /cargo.{0,30}(below|under|<|less)|below\s*\$?\s*100/i.test(query);

        // Expiring / expired COI via extraction fields
        if (wantsExpiring || wantsExpired) {
            const fields = await prisma.documentExtractionField.findMany({
                where: {
                    fieldKey: { in: ["policyExp", "expirationDate"] },
                    extraction: {
                        documentType: { in: ["COI", "INSURANCE"] },
                        job: { status: { in: ["SUCCEEDED", "CACHED"] } },
                    },
                },
                take: 80,
                include: {
                    extraction: { include: { job: { include: { validation: true } } } },
                },
            });
            for (const f of fields) {
                const exp = parseUsDate(f.valueNormalized || f.valueText);
                if (!exp) continue;
                const expired = exp.getTime() < Date.now();
                const thisMonth = exp >= from && exp <= to;
                if (wantsExpired && !expired) continue;
                if (wantsExpiring && !wantsExpired && !thisMonth && !expired) continue;
                const carrierId = f.extraction.job.carrierId;
                if (!carrierId) continue;
                try {
                    await carrierService.assertCarrierAccess(carrierId, actor);
                } catch {
                    continue;
                }
                const carrier = await prisma.carrier.findUnique({
                    where: { carrierId },
                    select: { legalName: true, mcNumber: true },
                });
                out.push({
                    type: "EXTRACTION",
                    id: f.extraction.extractionId,
                    title: `${carrier?.legalName || "Carrier"} — insurance ${expired ? "EXPIRED" : "expiring"}`,
                    snippet: snippetOf(
                        `policyExp=${f.valueNormalized || f.valueText}`,
                        f.extraction.job.validation?.overallStatus,
                        carrier?.mcNumber && `MC ${carrier.mcNumber}`
                    ),
                    matchedFields: ["policyExp"],
                    score: SCORE.EXACT_FIELD,
                    metadata: {
                        sourceType: "document_extraction",
                        carrierId,
                        documentId: f.extraction.job.documentId,
                        documentType: f.extraction.documentType,
                        policyExp: f.valueNormalized || f.valueText,
                        validationStatus: f.extraction.job.validation?.overallStatus || null,
                        compliance: expired ? "EXPIRED" : "EXPIRING_SOON",
                    },
                });
            }
        }

        if (wantsLowCargo) {
            const fields = await prisma.documentExtractionField.findMany({
                where: {
                    fieldKey: "cargoLimit",
                    extraction: {
                        documentType: { in: ["COI", "INSURANCE"] },
                        job: { status: { in: ["SUCCEEDED", "CACHED"] } },
                    },
                },
                take: 80,
                include: {
                    extraction: { include: { job: true } },
                },
            });
            for (const f of fields) {
                const n = Number(String(f.valueNormalized || f.valueText || "").replace(/[^\d.]/g, ""));
                if (!Number.isFinite(n) || n >= 100000) continue;
                const carrierId = f.extraction.job.carrierId;
                if (!carrierId) continue;
                try {
                    await carrierService.assertCarrierAccess(carrierId, actor);
                } catch {
                    continue;
                }
                out.push({
                    type: "EXTRACTION",
                    id: f.extraction.extractionId,
                    title: `Cargo below $100,000`,
                    snippet: snippetOf(`cargoLimit=${f.valueNormalized || f.valueText}`),
                    matchedFields: ["cargoLimit"],
                    score: SCORE.EXACT_FIELD,
                    metadata: {
                        sourceType: "document_extraction",
                        carrierId,
                        documentId: f.extraction.job.documentId,
                        cargoLimit: f.valueNormalized || f.valueText,
                        compliance: "BELOW_REQUIREMENT",
                    },
                });
            }
        }

        if (wantsMissingW9) {
            const carriers = await prisma.carrier.findMany({
                where: isBroker(actor) ? { assignedBrokerId: actor.userId } : {},
                take: 100,
                select: {
                    carrierId: true,
                    legalName: true,
                    mcNumber: true,
                    documents: {
                        where: { documentType: "W9", status: "CURRENT" },
                        select: { documentId: true },
                        take: 1,
                    },
                },
            });
            for (const c of carriers) {
                if (c.documents.length) continue;
                out.push({
                    type: "CARRIER",
                    id: c.carrierId,
                    title: `${c.legalName} — missing W9`,
                    snippet: snippetOf(c.mcNumber && `MC ${c.mcNumber}`, "W9: MISSING"),
                    matchedFields: ["documentType"],
                    score: SCORE.EXACT_FIELD,
                    metadata: {
                        sourceType: "carrier",
                        carrierId: c.carrierId,
                        compliance: "MISSING_W9",
                        mcNumber: c.mcNumber,
                    },
                });
            }
        }

        // Validation status RED/EXPIRED when asked about compliance
        if (/compliant|validation|invalid|review/i.test(query) && filters.carrierId) {
            try {
                await carrierService.assertCarrierAccess(filters.carrierId, actor);
                const jobs = await prisma.aiDocumentJob.findMany({
                    where: {
                        carrierId: filters.carrierId,
                        status: { in: ["SUCCEEDED", "CACHED"] },
                        validation: { isNot: null },
                    },
                    take: 20,
                    include: { validation: true, extraction: true },
                    orderBy: { completedAt: "desc" },
                });
                for (const j of jobs) {
                    if (!j.validation) continue;
                    out.push({
                        type: "EXTRACTION",
                        id: j.extraction?.extractionId || j.jobId,
                        title: `${j.classifiedDocType || j.declaredDocType || "Document"} — ${j.validation.overallStatus}`,
                        snippet: snippetOf(j.validation.trafficLight, j.validation.overallStatus),
                        matchedFields: ["validationStatus"],
                        score: SCORE.EXACT_FIELD,
                        metadata: {
                            sourceType: "document_validation",
                            carrierId: filters.carrierId,
                            documentId: j.documentId,
                            overallStatus: j.validation.overallStatus,
                            trafficLight: j.validation.trafficLight,
                        },
                    });
                }
            } catch {
                /* ACL deny */
            }
        }

        void filters;
        return out;
    }

    private async searchEmails(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const out: KnowledgeSearchResult[] = [];
        const load = filters.loadNumber || query.match(/\b(GL\d{4,}|\d{4,6})\b/i)?.[1];
        let shipmentLeadId = filters.shipmentId || null;
        if (load && !shipmentLeadId) {
            const lead = await prisma.shipmentLead.findFirst({
                where: {
                    OR: [{ loadNumber: load }, { loadNumber: { contains: load } }],
                    ...(isBroker(actor) ? { assignedBrokerId: actor.userId } : {}),
                },
                select: { shipmentLeadId: true },
            });
            shipmentLeadId = lead?.shipmentLeadId || null;
        }
        if (shipmentLeadId) {
            try {
                await assertShipmentAccessOrThrow(actor, shipmentLeadId);
            } catch {
                return [];
            }
        }

        // Broker mailbox — always scoped to actor for Brokers; others may filter by shipment
        const mailboxWhere: Record<string, unknown> = {};
        if (isBroker(actor)) mailboxWhere.userId = actor.userId;
        if (shipmentLeadId) mailboxWhere.shipmentLeadId = shipmentLeadId;
        if (query.length >= 3) {
            mailboxWhere.OR = [
                { subject: { contains: query.slice(0, 80) } },
                { snippet: { contains: query.slice(0, 80) } },
                { fromAddress: { contains: query.slice(0, 80) } },
                { bodyText: { contains: query.slice(0, 80) } },
            ];
        }
        if (!shipmentLeadId && !isBroker(actor) && !mailboxWhere.OR) {
            // Avoid unbounded email dump for admins without query
            if (query.length < 3) return [];
        }

        const mailbox = await prisma.brokerMailboxMessage.findMany({
            where: mailboxWhere,
            take: 15,
            orderBy: { receivedAt: "desc" },
            select: {
                messageId: true,
                userId: true,
                shipmentLeadId: true,
                fromAddress: true,
                subject: true,
                snippet: true,
                receivedAt: true,
            },
        });

        for (const m of mailbox) {
            if (isBroker(actor) && m.userId !== actor.userId) continue;
            if (m.shipmentLeadId) {
                try {
                    await assertShipmentAccessOrThrow(actor, m.shipmentLeadId);
                } catch {
                    continue;
                }
            }
            out.push({
                type: "EMAIL",
                id: m.messageId,
                title: m.subject,
                snippet: snippetOf(m.fromAddress, m.snippet, m.receivedAt.toISOString().slice(0, 10)),
                matchedFields: ["subject", "snippet"],
                score: SCORE.KEYWORD,
                metadata: {
                    sourceType: "email",
                    shipmentLeadId: m.shipmentLeadId || undefined,
                    fromAddress: m.fromAddress,
                    receivedAt: m.receivedAt.toISOString(),
                    mailbox: "broker",
                },
            });
        }

        // EmailMessage (uShip importer) — only when linked to accessible shipment
        if (shipmentLeadId) {
            const emails = await prisma.emailMessage.findMany({
                where: {
                    shipmentLeads: { some: { shipmentLeadId } },
                    ...(query.length >= 3
                        ? {
                              OR: [
                                  { subject: { contains: query.slice(0, 80) } },
                                  { snippet: { contains: query.slice(0, 80) } },
                                  { fromAddress: { contains: query.slice(0, 80) } },
                                  { bodyText: { contains: query.slice(0, 80) } },
                              ],
                          }
                        : {}),
                },
                take: 10,
                orderBy: { receivedAt: "desc" },
                select: {
                    emailMessageId: true,
                    fromAddress: true,
                    subject: true,
                    snippet: true,
                    receivedAt: true,
                },
            });
            for (const e of emails) {
                out.push({
                    type: "EMAIL",
                    id: e.emailMessageId,
                    title: e.subject,
                    snippet: snippetOf(e.fromAddress, e.snippet, e.receivedAt.toISOString().slice(0, 10)),
                    matchedFields: ["subject"],
                    score: SCORE.KEYWORD,
                    metadata: {
                        sourceType: "email",
                        shipmentLeadId,
                        fromAddress: e.fromAddress,
                        receivedAt: e.receivedAt.toISOString(),
                        mailbox: "importer",
                    },
                });
            }
        }

        return out;
    }

    private async searchTimeline(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const load = filters.loadNumber || query.match(/\b(GL\d{4,}|\d{4,6})\b/i)?.[1];
        let shipmentLeadId = filters.shipmentId || null;
        if (!shipmentLeadId && load) {
            const lead = await prisma.shipmentLead.findFirst({
                where: {
                    OR: [{ loadNumber: load }, { loadNumber: { contains: load } }],
                    ...(isBroker(actor) ? { assignedBrokerId: actor.userId } : {}),
                },
                select: { shipmentLeadId: true },
            });
            shipmentLeadId = lead?.shipmentLeadId || null;
        }
        if (!shipmentLeadId) return [];
        try {
            await assertShipmentAccessOrThrow(actor, shipmentLeadId);
        } catch {
            return [];
        }

        let dateFrom: Date | undefined;
        let dateTo: Date | undefined;
        if (filters.dateFrom) dateFrom = new Date(filters.dateFrom);
        if (filters.dateTo) dateTo = new Date(filters.dateTo);
        if (/yesterday/i.test(query)) {
            const y = new Date();
            y.setDate(y.getDate() - 1);
            y.setHours(0, 0, 0, 0);
            dateFrom = y;
            dateTo = new Date(y);
            dateTo.setHours(23, 59, 59, 999);
        }

        const createdAt =
            dateFrom || dateTo
                ? {
                      ...(dateFrom ? { gte: dateFrom } : {}),
                      ...(dateTo ? { lte: dateTo } : {}),
                  }
                : undefined;

        const [domain, timeline] = await Promise.all([
            prisma.domainEvent.findMany({
                where: { shipmentLeadId, ...(createdAt ? { createdAt } : {}) },
                orderBy: { createdAt: "asc" },
                take: 40,
                select: {
                    eventId: true,
                    eventType: true,
                    title: true,
                    message: true,
                    createdAt: true,
                    shipmentLeadId: true,
                },
            }),
            prisma.shipmentTimelineEvent.findMany({
                where: { shipmentLeadId, ...(createdAt ? { createdAt } : {}) },
                orderBy: { createdAt: "asc" },
                take: 40,
                select: {
                    eventId: true,
                    stage: true,
                    title: true,
                    message: true,
                    createdAt: true,
                    shipmentLeadId: true,
                },
            }),
        ]);

        const out: KnowledgeSearchResult[] = [];
        for (const e of domain) {
            out.push({
                type: "TIMELINE",
                id: e.eventId,
                title: e.title,
                snippet: snippetOf(e.eventType, e.message, e.createdAt.toISOString()),
                matchedFields: ["eventType", "title"],
                score: SCORE.EXACT_FIELD,
                metadata: {
                    sourceType: "domain_event",
                    shipmentLeadId,
                    eventType: e.eventType,
                    createdAt: e.createdAt.toISOString(),
                },
            });
        }
        for (const e of timeline) {
            out.push({
                type: "TIMELINE",
                id: e.eventId,
                title: e.title,
                snippet: snippetOf(e.stage, e.message, e.createdAt.toISOString()),
                matchedFields: ["stage", "title"],
                score: SCORE.EXACT_FIELD,
                metadata: {
                    sourceType: "shipment_timeline",
                    shipmentLeadId,
                    stage: e.stage,
                    createdAt: e.createdAt.toISOString(),
                },
            });
        }
        out.sort((a, b) =>
            String(a.metadata.createdAt).localeCompare(String(b.metadata.createdAt))
        );
        return out;
    }

    private async compareAuthorityVsCoi(
        actor: KnowledgeSearchActor,
        query: string,
        filters: KnowledgeSearchFilters
    ): Promise<KnowledgeSearchResult[]> {
        const mc = normalizeMc(filters.mc || extractMcDigits(query) || "");
        let carrierId = filters.carrierId || null;
        if (!carrierId && mc) {
            const hits = await this.searchCarriers(actor, mc, { mc });
            carrierId = hits[0]?.id || null;
        }
        if (!carrierId) {
            const name = query.match(/\b([A-Z][A-Za-z0-9&.\s-]{2,50}(?:LLC|Inc|Trucking|Transport))\b/)?.[1];
            if (name) {
                const hits = await this.searchCarriers(actor, name, {});
                carrierId = hits[0]?.id || null;
            }
        }
        if (!carrierId) return [];
        try {
            await carrierService.assertCarrierAccess(carrierId, actor);
        } catch {
            return [];
        }

        const carrier = await prisma.carrier.findUnique({
            where: { carrierId },
            select: { legalName: true, mcNumber: true, dotNumber: true },
        });

        const fields = await prisma.documentExtractionField.findMany({
            where: {
                fieldKey: { in: ["mcNumber", "dotNumber", "legalName", "insuredName", "carrierMc", "carrierDot"] },
                extraction: {
                    documentType: { in: ["MC_AUTHORITY", "COI", "INSURANCE"] },
                    job: { carrierId, status: { in: ["SUCCEEDED", "CACHED"] } },
                },
            },
            include: { extraction: true },
            take: 40,
        });

        const auth: Record<string, string | null> = {};
        const coi: Record<string, string | null> = {};
        for (const f of fields) {
            const bucket =
                f.extraction.documentType === "MC_AUTHORITY" ? auth : coi;
            const key =
                f.fieldKey === "insuredName" || f.fieldKey === "legalName"
                    ? "legalName"
                    : f.fieldKey === "carrierMc"
                      ? "mcNumber"
                      : f.fieldKey === "carrierDot"
                        ? "dotNumber"
                        : f.fieldKey;
            bucket[key] = f.valueNormalized || f.valueText;
        }

        const authMc = normalizeMc(auth.mcNumber);
        const coiMc = normalizeMc(coi.mcNumber);
        const gosMc = normalizeMc(carrier?.mcNumber);
        const authDot = normalizeDot(auth.dotNumber);
        const coiDot = normalizeDot(coi.dotNumber);
        const gosDot = normalizeDot(carrier?.dotNumber);

        const mcStatus =
            authMc && coiMc && gosMc
                ? authMc === coiMc && coiMc === gosMc
                    ? "MATCH"
                    : "CRITICAL_MISMATCH"
                : authMc && coiMc
                  ? authMc === coiMc
                      ? "MATCH"
                      : "CRITICAL_MISMATCH"
                  : "MISSING";

        const dotStatus =
            authDot && coiDot && gosDot
                ? authDot === coiDot && coiDot === gosDot
                    ? "MATCH"
                    : "CRITICAL_MISMATCH"
                : authDot && coiDot
                  ? authDot === coiDot
                      ? "MATCH"
                      : "CRITICAL_MISMATCH"
                  : "MISSING";

        return [
            {
                type: "EXTRACTION",
                id: `cross-mc-coi-${carrierId}`,
                title: `MC Authority vs COI vs GreenOS — ${carrier?.legalName || carrierId}`,
                snippet: snippetOf(
                    `MC: Authority=${authMc || "—"} COI=${coiMc || "—"} GreenOS=${gosMc || "—"} → ${mcStatus}`,
                    `DOT: Authority=${authDot || "—"} COI=${coiDot || "—"} GreenOS=${gosDot || "—"} → ${dotStatus}`
                ),
                matchedFields: ["mcNumber", "dotNumber"],
                score: SCORE.EXACT_FIELD,
                metadata: {
                    sourceType: "cross_document",
                    carrierId,
                    comparison: {
                        mc: { authority: authMc, coi: coiMc, greenOs: gosMc, status: mcStatus },
                        dot: { authority: authDot, coi: coiDot, greenOs: gosDot, status: dotStatus },
                        legalName: {
                            authority: auth.legalName || null,
                            coi: coi.legalName || null,
                            greenOs: carrier?.legalName || null,
                        },
                    },
                },
            },
        ];
    }
}

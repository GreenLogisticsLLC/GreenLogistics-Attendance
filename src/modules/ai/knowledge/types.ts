/**
 * Phase 3 — GreenOS Knowledge Search types.
 * LLM never sees raw Prisma rows; only these normalized shapes.
 */

export type KnowledgeEntityType =
    | "CARRIER"
    | "SHIPMENT"
    | "DOCUMENT"
    | "EMAIL"
    | "TIMELINE"
    | "EXTRACTION";

export type KnowledgeSearchResult = {
    type: KnowledgeEntityType | string;
    id: string;
    title: string;
    snippet: string;
    matchedFields: string[];
    score: number;
    metadata: Record<string, unknown>;
};

export type KnowledgeSearchFilters = {
    entityType?: KnowledgeEntityType | KnowledgeEntityType[];
    carrierId?: string;
    shipmentId?: string;
    documentType?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    mc?: string;
    dot?: string;
    loadNumber?: string;
    /** Intent hint from orchestrator — narrows which stores are queried. */
    intentHint?: string;
};

export type KnowledgeSearchSource = {
    type: string;
    id: string;
    label: string;
    carrierId?: string;
    shipmentLeadId?: string;
};

export type KnowledgeSearchResponse = {
    results: KnowledgeSearchResult[];
    sources: KnowledgeSearchSource[];
    searchMode: "STRUCTURED";
    resultCount: number;
};

export type KnowledgeSearchActor = {
    userId: string;
    role: string;
};

export type KnowledgeSearchRequest = {
    actor: KnowledgeSearchActor;
    query: string;
    filters?: KnowledgeSearchFilters;
    limit?: number;
};

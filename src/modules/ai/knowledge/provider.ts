import type { KnowledgeSearchRequest, KnowledgeSearchResponse } from "./types.js";

/**
 * Provider interface — Structured now; Embedding later without rewriting orchestrator.
 */
export interface KnowledgeSearchProvider {
    readonly name: string;
    search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse>;
}

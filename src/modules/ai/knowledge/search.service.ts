import type { KnowledgeSearchProvider } from "./provider.js";
import { StructuredKnowledgeSearchProvider } from "./structured-provider.js";
import type { KnowledgeSearchRequest, KnowledgeSearchResponse } from "./types.js";

/**
 * GreenOsKnowledgeSearch — single controlled facade.
 * Swap provider later (embeddings) without changing orchestrator.
 */
export class GreenOsKnowledgeSearch {
    constructor(private readonly provider: KnowledgeSearchProvider = new StructuredKnowledgeSearchProvider()) {}

    get searchMode(): string {
        return this.provider.name;
    }

    async searchGreenOS(
        query: string,
        scope: KnowledgeSearchRequest["filters"],
        actor: KnowledgeSearchRequest["actor"],
        limit?: number
    ): Promise<KnowledgeSearchResponse> {
        return this.provider.search({
            actor,
            query,
            filters: scope,
            limit,
        });
    }

    async search(input: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
        return this.provider.search(input);
    }
}

export const greenOsKnowledgeSearch = new GreenOsKnowledgeSearch();

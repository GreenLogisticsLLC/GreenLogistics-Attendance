/**
 * Central OpenAI token pricing (USD per 1M tokens).
 * Single source — do not hardcode prices elsewhere.
 */
export type ModelPricing = {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
    "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
    "gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
    "gpt-4.1-mini": { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6 },
    "gpt-4.1": { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
    "gpt-5.5": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
};

const DEFAULT_PRICING: ModelPricing = {
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.6,
};

export function getModelPricing(model: string): ModelPricing {
    const key = String(model || "")
        .trim()
        .toLowerCase();
    if (MODEL_PRICING[key]) return MODEL_PRICING[key];
    // Match prefix e.g. gpt-4o-mini-2024-07-18
    for (const name of Object.keys(MODEL_PRICING)) {
        if (key.startsWith(name)) return MODEL_PRICING[name];
    }
    return DEFAULT_PRICING;
}

export function estimateCostUsd(input: {
    model: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
}): number | null {
    const prompt = Number(input.promptTokens);
    const completion = Number(input.completionTokens);
    if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
    const pricing = getModelPricing(input.model);
    const p = Number.isFinite(prompt) ? prompt : 0;
    const c = Number.isFinite(completion) ? completion : 0;
    const usd =
        (p / 1_000_000) * pricing.inputPerMillionUsd +
        (c / 1_000_000) * pricing.outputPerMillionUsd;
    return Math.round(usd * 1_000_000) / 1_000_000;
}

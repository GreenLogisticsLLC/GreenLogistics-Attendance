/**
 * Simple in-memory per-user rate limit for /api/ai/chat.
 * Compatible with single-process PM2 fork mode used in production.
 */
const hits = new Map<string, number[]>();

export function getAiChatRateLimitPerMinute(): number {
    const n = Number(process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE || 20);
    if (!Number.isFinite(n) || n < 1) return 20;
    return Math.min(Math.floor(n), 500);
}

export function assertAiChatRateLimit(userId: string): void {
    const limit = getAiChatRateLimitPerMinute();
    const now = Date.now();
    const windowMs = 60_000;
    const key = String(userId || "anonymous");
    const prev = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (prev.length >= limit) {
        throw Object.assign(
            new Error(
                `AI rate limit exceeded (${limit} requests per minute). Please wait and try again.`
            ),
            { status: 429, code: "AI_RATE_LIMITED" }
        );
    }
    prev.push(now);
    hits.set(key, prev);
}

/** Test helper — clear buckets. */
export function _resetAiRateLimitForTests(): void {
    hits.clear();
}

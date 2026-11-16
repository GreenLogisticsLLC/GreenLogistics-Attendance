import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../../config/env.js";
import {
    clearPayPalTokenCache,
    getPayPalAccessToken,
    verifyPayPalWebhookSignatureDetailed,
} from "./paypal-client.js";
import { getActivePayPalEnv, getPayPalEnv, listWebhookCapablePayPalEnvs } from "./paypal-env.js";

const originalFetch = globalThis.fetch;

function withEnv(
    values: Record<string, string | undefined>,
    fn: () => Promise<void>
) {
    const keys = Object.keys(values);
    const prev: Record<string, string | undefined> = {};
    for (const key of keys) {
        prev[key] = process.env[key];
        const next = values[key];
        if (next === undefined) delete process.env[key];
        else process.env[key] = next;
    }
    // Also clear sibling vars not listed when undefined intentionally omitted.
    return fn().finally(() => {
        for (const key of keys) {
            if (prev[key] === undefined) delete process.env[key];
            else process.env[key] = prev[key];
        }
        globalThis.fetch = originalFetch;
        clearPayPalTokenCache();
    });
}

const webhookHeaders = {
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-time": "2026-11-16T00:00:00Z",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "sig",
};

test("legacy PAYPAL_CLIENT_* maps to Sandbox only; LIVE stays empty", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "sandbox",
            PAYPAL_CLIENT_ID: "legacy-id",
            PAYPAL_CLIENT_SECRET: "legacy-secret",
            PAYPAL_WEBHOOK_ID: "WH-LEGACY",
            PAYPAL_SANDBOX_CLIENT_ID: undefined,
            PAYPAL_SANDBOX_CLIENT_SECRET: undefined,
            PAYPAL_SANDBOX_WEBHOOK_ID: undefined,
            PAYPAL_LIVE_CLIENT_ID: undefined,
            PAYPAL_LIVE_CLIENT_SECRET: undefined,
            PAYPAL_LIVE_WEBHOOK_ID: undefined,
        },
        async () => {
            assert.equal(getPayPalEnv("sandbox").clientId, "legacy-id");
            assert.equal(getPayPalEnv("sandbox").webhookId, "WH-LEGACY");
            assert.equal(getPayPalEnv("live").configured, false);
            assert.equal(getActivePayPalEnv().environment, "sandbox");
            assert.equal(config.paypal.configured, true);
        }
    );
});

test("missing LIVE credentials do not break Sandbox checkout config", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "sandbox",
            PAYPAL_SANDBOX_CLIENT_ID: "sb-id",
            PAYPAL_SANDBOX_CLIENT_SECRET: "sb-secret",
            PAYPAL_SANDBOX_WEBHOOK_ID: "WH-SB",
            PAYPAL_LIVE_CLIENT_ID: undefined,
            PAYPAL_LIVE_CLIENT_SECRET: undefined,
            PAYPAL_LIVE_WEBHOOK_ID: undefined,
            PAYPAL_CLIENT_ID: undefined,
            PAYPAL_CLIENT_SECRET: undefined,
            PAYPAL_WEBHOOK_ID: undefined,
        },
        async () => {
            assert.equal(config.paypal.configured, true);
            assert.equal(config.paypal.sandbox.webhookConfigured, true);
            assert.equal(config.paypal.live.configured, false);
            assert.equal(listWebhookCapablePayPalEnvs().map((e) => e.environment).join(","), "sandbox");
        }
    );
});

test("missing Sandbox credentials do not silently fall back to LIVE", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "sandbox",
            PAYPAL_SANDBOX_CLIENT_ID: undefined,
            PAYPAL_SANDBOX_CLIENT_SECRET: undefined,
            PAYPAL_SANDBOX_WEBHOOK_ID: undefined,
            PAYPAL_CLIENT_ID: undefined,
            PAYPAL_CLIENT_SECRET: undefined,
            PAYPAL_WEBHOOK_ID: undefined,
            PAYPAL_LIVE_CLIENT_ID: "live-id",
            PAYPAL_LIVE_CLIENT_SECRET: "live-secret",
            PAYPAL_LIVE_WEBHOOK_ID: "WH-LIVE",
        },
        async () => {
            assert.equal(getActivePayPalEnv().configured, false);
            assert.equal(getPayPalEnv("live").configured, true);
            assert.equal(config.paypal.mode, "sandbox");
            assert.equal(config.paypal.configured, false);
        }
    );
});

test("LIVE webhook verifies with LIVE credentials; Sandbox credentials cannot verify LIVE", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "sandbox",
            PAYPAL_SANDBOX_CLIENT_ID: "sb-id",
            PAYPAL_SANDBOX_CLIENT_SECRET: "sb-secret",
            PAYPAL_SANDBOX_WEBHOOK_ID: "WH-SB",
            PAYPAL_LIVE_CLIENT_ID: "live-id",
            PAYPAL_LIVE_CLIENT_SECRET: "live-secret",
            PAYPAL_LIVE_WEBHOOK_ID: "WH-LIVE",
        },
        async () => {
            clearPayPalTokenCache();
            const seen: Array<{ url: string; webhookId?: string; basic?: string }> = [];
            globalThis.fetch = (async (urlLike: RequestInfo | URL, init?: RequestInit) => {
                const url = String(urlLike);
                if (url.endsWith("/v1/oauth2/token")) {
                    const auth = new Headers(init?.headers || {}).get("Authorization") || "";
                    const basic = auth.replace(/^Basic\s+/i, "");
                    seen.push({ url, basic });
                    const isLive = url.includes("api-m.paypal.com");
                    const json = {
                        access_token: isLive ? "live-tok" : "sb-tok",
                        expires_in: 3600,
                    };
                    return {
                        ok: true,
                        status: 200,
                        json: async () => json,
                        text: async () => JSON.stringify(json),
                    } as Response;
                }
                if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
                    const body = JSON.parse(String(init?.body || "{}")) as {
                        webhook_id?: string;
                    };
                    seen.push({ url, webhookId: body.webhook_id });
                    const success = body.webhook_id === "WH-LIVE";
                    const json = {
                        verification_status: success ? "SUCCESS" : "FAILURE",
                    };
                    return {
                        ok: true,
                        status: 200,
                        json: async () => json,
                        text: async () => JSON.stringify(json),
                    } as Response;
                }
                throw new Error(`unexpected ${url}`);
            }) as typeof fetch;

            const liveHeaders = {
                ...webhookHeaders,
                "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-LIVE",
            };
            const result = await verifyPayPalWebhookSignatureDetailed({
                headers: liveHeaders,
                rawBody: JSON.stringify({
                    id: "WH-EVT-LIVE",
                    event_type: "PAYMENT.CAPTURE.COMPLETED",
                }),
            });
            assert.equal(result.verified, true);
            assert.equal(result.environment, "live");
            assert.ok(seen.some((s) => s.webhookId === "WH-LIVE"));
            // Sandbox-only verify attempt would use WH-SB and fail — covered by dual loop.
            assert.ok(
                seen.some((s) => s.url.includes("api-m.paypal.com") && s.url.includes("oauth2"))
            );
        }
    );
});

test("Sandbox webhook verifies with Sandbox credentials; LIVE credentials cannot verify Sandbox", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "live",
            PAYPAL_SANDBOX_CLIENT_ID: "sb-id",
            PAYPAL_SANDBOX_CLIENT_SECRET: "sb-secret",
            PAYPAL_SANDBOX_WEBHOOK_ID: "WH-SB",
            PAYPAL_LIVE_CLIENT_ID: "live-id",
            PAYPAL_LIVE_CLIENT_SECRET: "live-secret",
            PAYPAL_LIVE_WEBHOOK_ID: "WH-LIVE",
        },
        async () => {
            clearPayPalTokenCache();
            globalThis.fetch = (async (urlLike: RequestInfo | URL, init?: RequestInit) => {
                const url = String(urlLike);
                if (url.endsWith("/v1/oauth2/token")) {
                    const json = {
                        access_token: url.includes("sandbox") ? "sb-tok" : "live-tok",
                        expires_in: 3600,
                    };
                    return {
                        ok: true,
                        status: 200,
                        json: async () => json,
                        text: async () => JSON.stringify(json),
                    } as Response;
                }
                if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
                    const body = JSON.parse(String(init?.body || "{}")) as {
                        webhook_id?: string;
                    };
                    const json = {
                        verification_status:
                            body.webhook_id === "WH-SB" ? "SUCCESS" : "FAILURE",
                    };
                    return {
                        ok: true,
                        status: 200,
                        json: async () => json,
                        text: async () => JSON.stringify(json),
                    } as Response;
                }
                throw new Error(`unexpected ${url}`);
            }) as typeof fetch;

            const result = await verifyPayPalWebhookSignatureDetailed({
                headers: webhookHeaders,
                rawBody: JSON.stringify({
                    id: "WH-EVT-SB",
                    event_type: "CHECKOUT.ORDER.APPROVED",
                }),
            });
            assert.equal(result.verified, true);
            assert.equal(result.environment, "sandbox");
            // Active Checkout mode is live, but Sandbox webhook still verifies.
            assert.equal(config.paypal.mode, "live");
        }
    );
});

test("invalid signatures are rejected", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "sandbox",
            PAYPAL_SANDBOX_CLIENT_ID: "sb-id",
            PAYPAL_SANDBOX_CLIENT_SECRET: "sb-secret",
            PAYPAL_SANDBOX_WEBHOOK_ID: "WH-SB",
            PAYPAL_LIVE_CLIENT_ID: "live-id",
            PAYPAL_LIVE_CLIENT_SECRET: "live-secret",
            PAYPAL_LIVE_WEBHOOK_ID: "WH-LIVE",
        },
        async () => {
            clearPayPalTokenCache();
            globalThis.fetch = (async (urlLike: RequestInfo | URL) => {
                const url = String(urlLike);
                if (url.endsWith("/v1/oauth2/token")) {
                    const json = { access_token: "tok", expires_in: 3600 };
                    return {
                        ok: true,
                        status: 200,
                        json: async () => json,
                        text: async () => JSON.stringify(json),
                    } as Response;
                }
                if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
                    const json = { verification_status: "FAILURE" };
                    return {
                        ok: true,
                        status: 200,
                        json: async () => json,
                        text: async () => JSON.stringify(json),
                    } as Response;
                }
                throw new Error(`unexpected ${url}`);
            }) as typeof fetch;

            const result = await verifyPayPalWebhookSignatureDetailed({
                headers: webhookHeaders,
                rawBody: JSON.stringify({ id: "WH-BAD", event_type: "PAYMENT.CAPTURE.COMPLETED" }),
            });
            assert.equal(result.verified, false);
            assert.equal(result.environment, null);
        }
    );
});

test("OAuth tokens are cached per environment", async () => {
    await withEnv(
        {
            PAYPAL_MODE: "sandbox",
            PAYPAL_SANDBOX_CLIENT_ID: "sb-id",
            PAYPAL_SANDBOX_CLIENT_SECRET: "sb-secret",
            PAYPAL_LIVE_CLIENT_ID: "live-id",
            PAYPAL_LIVE_CLIENT_SECRET: "live-secret",
        },
        async () => {
            clearPayPalTokenCache();
            let calls = 0;
            globalThis.fetch = (async (urlLike: RequestInfo | URL) => {
                calls += 1;
                const url = String(urlLike);
                const json = {
                    access_token: url.includes("sandbox") ? "sb" : "live",
                    expires_in: 3600,
                };
                return {
                    ok: true,
                    status: 200,
                    json: async () => json,
                    text: async () => JSON.stringify(json),
                } as Response;
            }) as typeof fetch;
            assert.equal(await getPayPalAccessToken("sandbox"), "sb");
            assert.equal(await getPayPalAccessToken("sandbox"), "sb");
            assert.equal(await getPayPalAccessToken("live"), "live");
            assert.equal(await getPayPalAccessToken("live"), "live");
            assert.equal(calls, 2);
        }
    );
});

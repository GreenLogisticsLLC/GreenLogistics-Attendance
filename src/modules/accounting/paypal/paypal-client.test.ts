import assert from "node:assert/strict";
import test from "node:test";
import {
    clearPayPalTokenCache,
    createPayPalOrder,
    getPayPalAccessToken,
    getPayPalOrder,
    capturePayPalOrder,
} from "./paypal-client.js";

const originalFetch = globalThis.fetch;

function withPayPalEnv(fn: () => Promise<void>) {
    const prev = {
        PAYPAL_MODE: process.env.PAYPAL_MODE,
        PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
        PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
        PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID,
    };
    process.env.PAYPAL_MODE = "sandbox";
    process.env.PAYPAL_CLIENT_ID = "test-client";
    process.env.PAYPAL_CLIENT_SECRET = "test-secret";
    process.env.PAYPAL_WEBHOOK_ID = "WH-TEST";
    return fn().finally(() => {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        globalThis.fetch = originalFetch;
        clearPayPalTokenCache();
    });
}

test("getPayPalAccessToken caches until near expiry", async () => {
    await withPayPalEnv(async () => {
        clearPayPalTokenCache();
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            const json = { access_token: "tok-1", expires_in: 3600 };
            return {
                ok: true,
                status: 200,
                statusText: "OK",
                json: async () => json,
                text: async () => JSON.stringify(json),
            } as Response;
        }) as typeof fetch;
        const a = await getPayPalAccessToken();
        const b = await getPayPalAccessToken();
        assert.equal(a, "tok-1");
        assert.equal(b, "tok-1");
        assert.equal(calls, 1);
    });
});

test("createPayPalOrder returns approval URL and uses CAPTURE + USD", async () => {
    await withPayPalEnv(async () => {
        clearPayPalTokenCache();
        let capturedBody: string | null = null;
        let capturedHeaders: Headers | null = null;
        let call = 0;
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            call += 1;
            if (call === 1) {
                const json = { access_token: "tok-x", expires_in: 3600 };
                return {
                    ok: true,
                    status: 200,
                    statusText: "OK",
                    json: async () => json,
                    text: async () => JSON.stringify(json),
                } as Response;
            }
            capturedBody = String(init?.body || "");
            capturedHeaders = new Headers(init?.headers || {});
            const json = {
                id: "ORDER-1",
                status: "CREATED",
                links: [
                    {
                        rel: "approve",
                        href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1",
                    },
                ],
            };
            return {
                ok: true,
                status: 201,
                statusText: "Created",
                text: async () => JSON.stringify(json),
                json: async () => json,
            } as Response;
        }) as typeof fetch;

        const order = await createPayPalOrder({
            amountUsd: 123.45,
            idempotencyKey: "idem-1",
            invoiceNumber: "INV-100",
            customId: "ship-1",
        });
        assert.equal(order.id, "ORDER-1");
        assert.equal(order.status, "CREATED");
        assert.match(String(order.approvalUrl), /sandbox\.paypal\.com/);
        assert.ok(capturedBody);
        const parsed = JSON.parse(capturedBody!);
        assert.equal(parsed.intent, "CAPTURE");
        assert.equal(parsed.purchase_units[0].amount.currency_code, "USD");
        assert.equal(parsed.purchase_units[0].amount.value, "123.45");
        assert.equal(capturedHeaders!.get("PayPal-Request-Id"), "idem-1");
    });
});

test("getPayPalOrder and capturePayPalOrder parse remote payloads", async () => {
    await withPayPalEnv(async () => {
        clearPayPalTokenCache();
        let call = 0;
        globalThis.fetch = (async () => {
            call += 1;
            if (call === 1) {
                const json = { access_token: "tok-y", expires_in: 3600 };
                return {
                    ok: true,
                    status: 200,
                    statusText: "OK",
                    text: async () => JSON.stringify(json),
                    json: async () => json,
                } as Response;
            }
            if (call === 2) {
                const json = {
                    id: "ORDER-2",
                    status: "APPROVED",
                    links: [{ rel: "approve", href: "https://example/approve" }],
                };
                return {
                    ok: true,
                    status: 200,
                    statusText: "OK",
                    text: async () => JSON.stringify(json),
                    json: async () => json,
                } as Response;
            }
            const json = {
                id: "ORDER-2",
                status: "COMPLETED",
                purchase_units: [
                    { payments: { captures: [{ id: "CAP-9", status: "COMPLETED" }] } },
                ],
            };
            return {
                ok: true,
                status: 200,
                statusText: "OK",
                text: async () => JSON.stringify(json),
                json: async () => json,
            } as Response;
        }) as typeof fetch;

        const got = await getPayPalOrder("ORDER-2");
        assert.equal(got.status, "APPROVED");
        // Token still cached from call 1 — next call is capture.
        const cap = await capturePayPalOrder("ORDER-2");
        assert.equal(cap.status, "COMPLETED");
        assert.equal(cap.captureId, "CAP-9");
    });
});

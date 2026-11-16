import {
    assertPayPalEnvConfigured,
    getActivePayPalEnv,
    getPayPalEnv,
    listWebhookCapablePayPalTargets,
    type PayPalWebhookTarget,
    type PayPalEnvironment,
    type PayPalEnvCredentials,
} from "./paypal-env.js";
import { config } from "../../../config/env.js";

type TokenCache = {
    accessToken: string;
    expiresAtMs: number;
};

const tokenCacheByEnv: Record<PayPalEnvironment, TokenCache | null> = {
    sandbox: null,
    live: null,
};

export type PayPalOrderResult = {
    id: string;
    status: string;
    approvalUrl: string | null;
    captureId: string | null;
    captureStatus: string | null;
    amountValue: string | null;
    currencyCode: string | null;
    raw: unknown;
    environment: PayPalEnvironment;
};

export type PayPalCaptureResult = {
    id: string;
    status: string;
    captureId: string | null;
    captureStatus: string | null;
    amountValue: string | null;
    currencyCode: string | null;
    raw: unknown;
    environment: PayPalEnvironment;
};

export type PayPalWebhookVerifyResult = {
    verified: boolean;
    environment: PayPalEnvironment | null;
    webhookKind?: PayPalWebhookTarget["webhookKind"];
    reason?: string;
};

export async function paypalFetch(
    env: PayPalEnvCredentials,
    path: string,
    init: RequestInit & { accessToken?: string } = {}
) {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    if (init.accessToken) {
        headers.set("Authorization", `Bearer ${init.accessToken}`);
    }
    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${env.apiBaseUrl}${path}`, {
        ...init,
        headers,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { raw: text };
    }
    if (!res.ok) {
        const detail =
            json && typeof json === "object" && "message" in json
                ? String((json as { message?: string }).message || "")
                : text.slice(0, 240);
        throw Object.assign(
            new Error(`PayPal API ${res.status}: ${detail || res.statusText}`),
            {
                status: 502,
                code: "PAYPAL_API_ERROR",
                paypalStatus: res.status,
                paypalEnvironment: env.environment,
            }
        );
    }
    return json;
}

export async function getPayPalAccessToken(
    environment: PayPalEnvironment = getActivePayPalEnv().environment,
    forceRefresh = false
): Promise<string> {
    const env = assertPayPalEnvConfigured(environment);
    const now = Date.now();
    const cached = tokenCacheByEnv[environment];
    if (!forceRefresh && cached && cached.expiresAtMs > now + 30_000) {
        return cached.accessToken;
    }
    const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`, "utf8").toString("base64");
    const res = await fetch(`${env.apiBaseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        body: "grant_type=client_credentials",
    });
    const json = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
    };
    if (!res.ok || !json.access_token) {
        throw Object.assign(
            new Error(
                `PayPal OAuth failed (${environment}): ${json.error_description || res.statusText || res.status}`
            ),
            { status: 502, code: "PAYPAL_OAUTH_FAILED", paypalEnvironment: environment }
        );
    }
    const expiresIn = Number(json.expires_in) || 3200;
    tokenCacheByEnv[environment] = {
        accessToken: json.access_token,
        expiresAtMs: now + expiresIn * 1000,
    };
    return json.access_token;
}

function pickApprovalUrl(order: {
    links?: Array<{ rel?: string; href?: string }>;
}): string | null {
    const links = order.links || [];
    const approve = links.find((l) => String(l.rel || "").toLowerCase() === "approve");
    return approve?.href || null;
}

type PayPalCaptureResource = {
    id?: string;
    status?: string;
    amount?: { value?: string; currency_code?: string };
};

function pickCapture(order: {
    purchase_units?: Array<{
        payments?: { captures?: PayPalCaptureResource[] };
    }>;
}): PayPalCaptureResource | null {
    return (
        order.purchase_units
            ?.flatMap((unit) => unit.payments?.captures || [])
            .find((capture) => capture.id) || null
    );
}

function activeOr(environment?: PayPalEnvironment): PayPalEnvironment {
    return environment || getActivePayPalEnv().environment;
}

export async function createPayPalOrder(input: {
    amountUsd: number;
    currency?: string;
    invoiceNumber?: string | null;
    description?: string;
    customId?: string;
    returnUrl?: string;
    cancelUrl?: string;
    idempotencyKey: string;
    environment?: PayPalEnvironment;
}): Promise<PayPalOrderResult> {
    const environment = activeOr(input.environment);
    const env = assertPayPalEnvConfigured(environment);
    const token = await getPayPalAccessToken(environment);
    const amount = Number(input.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw Object.assign(new Error("PayPal amount must be greater than zero"), {
            status: 422,
            code: "PAYPAL_INVALID_AMOUNT",
        });
    }
    const value = amount.toFixed(2);
    const currency = (input.currency || "USD").toUpperCase();
    const body = {
        intent: "CAPTURE",
        purchase_units: [
            {
                reference_id: String(input.customId || input.invoiceNumber || "greenos").slice(0, 256),
                description: String(input.description || "Green Logistics LLC shipment payment").slice(
                    0,
                    127
                ),
                custom_id: String(input.customId || "").slice(0, 127) || undefined,
                invoice_id: input.invoiceNumber
                    ? String(input.invoiceNumber).slice(0, 127)
                    : undefined,
                amount: {
                    currency_code: currency,
                    value,
                },
            },
        ],
        application_context: {
            brand_name: "Green Logistics LLC",
            landing_page: "NO_PREFERENCE",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url:
                input.returnUrl || `${config.publicAppUrl}/accounting?paypal=return`,
            cancel_url:
                input.cancelUrl || `${config.publicAppUrl}/accounting?paypal=cancel`,
        },
    };
    const json = (await paypalFetch(env, "/v2/checkout/orders", {
        method: "POST",
        accessToken: token,
        headers: {
            "PayPal-Request-Id": input.idempotencyKey,
            Prefer: "return=representation",
        },
        body: JSON.stringify(body),
    })) as {
        id?: string;
        status?: string;
        links?: Array<{ rel?: string; href?: string }>;
        purchase_units?: Array<{
            payments?: { captures?: PayPalCaptureResource[] };
        }>;
    };
    if (!json.id) {
        throw Object.assign(new Error("PayPal did not return an order id"), {
            status: 502,
            code: "PAYPAL_ORDER_MISSING",
        });
    }
    const capture = pickCapture(json);
    return {
        id: json.id,
        status: String(json.status || "CREATED"),
        approvalUrl: pickApprovalUrl(json),
        captureId: capture?.id || null,
        captureStatus: capture?.status || null,
        amountValue: capture?.amount?.value || null,
        currencyCode: capture?.amount?.currency_code || null,
        raw: json,
        environment,
    };
}

export async function getPayPalOrder(
    paypalOrderId: string,
    environment: PayPalEnvironment = getActivePayPalEnv().environment
): Promise<PayPalOrderResult> {
    const env = assertPayPalEnvConfigured(environment);
    const token = await getPayPalAccessToken(environment);
    const json = (await paypalFetch(
        env,
        `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`,
        {
            method: "GET",
            accessToken: token,
        }
    )) as {
        id?: string;
        status?: string;
        links?: Array<{ rel?: string; href?: string }>;
        purchase_units?: Array<{
            payments?: { captures?: PayPalCaptureResource[] };
        }>;
    };
    const capture = pickCapture(json);
    return {
        id: String(json.id || paypalOrderId),
        status: String(json.status || ""),
        approvalUrl: pickApprovalUrl(json),
        captureId: capture?.id || null,
        captureStatus: capture?.status || null,
        amountValue: capture?.amount?.value || null,
        currencyCode: capture?.amount?.currency_code || null,
        raw: json,
        environment,
    };
}

export async function capturePayPalOrder(
    paypalOrderId: string,
    captureRequestId: string,
    environment: PayPalEnvironment = getActivePayPalEnv().environment
): Promise<PayPalCaptureResult> {
    const env = assertPayPalEnvConfigured(environment);
    const token = await getPayPalAccessToken(environment);
    const json = (await paypalFetch(
        env,
        `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
        {
            method: "POST",
            accessToken: token,
            headers: {
                Prefer: "return=representation",
                "PayPal-Request-Id": captureRequestId,
            },
            body: "{}",
        }
    )) as {
        id?: string;
        status?: string;
        purchase_units?: Array<{
            payments?: { captures?: PayPalCaptureResource[] };
        }>;
    };
    const capture = pickCapture(json);
    return {
        id: String(json.id || paypalOrderId),
        status: String(json.status || ""),
        captureId: capture?.id || null,
        captureStatus: capture?.status || null,
        amountValue: capture?.amount?.value || null,
        currencyCode: capture?.amount?.currency_code || null,
        raw: json,
        environment,
    };
}

async function verifyWebhookAgainstTarget(
    target: PayPalWebhookTarget,
    input: {
        transmissionId: string;
        transmissionTime: string;
        certUrl: string;
        authAlgo: string;
        transmissionSig: string;
        webhookEvent: unknown;
    }
): Promise<boolean> {
    const env = assertPayPalEnvConfigured(target.environment);
    const token = await getPayPalAccessToken(target.environment);
    const json = (await paypalFetch(env, "/v1/notifications/verify-webhook-signature", {
        method: "POST",
        accessToken: token,
        body: JSON.stringify({
            transmission_id: input.transmissionId,
            transmission_time: input.transmissionTime,
            cert_url: input.certUrl,
            auth_algo: input.authAlgo,
            transmission_sig: input.transmissionSig,
            webhook_id: target.webhookId,
            webhook_event: input.webhookEvent,
        }),
    })) as { verification_status?: string };
    return String(json.verification_status || "").toUpperCase() === "SUCCESS";
}

/**
 * Dual-environment webhook verification.
 * Does not trust PAYPAL_MODE — tries each webhook-capable env with its own
 * credentials, API base, and webhook id (never mixed).
 */
export async function verifyPayPalWebhookSignatureDetailed(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
}): Promise<PayPalWebhookVerifyResult> {
    const capable = listWebhookCapablePayPalTargets();
    if (!capable.length) {
        throw Object.assign(
            new Error(
                "No PayPal webhook is configured — set Checkout webhook ids (PAYPAL_SANDBOX_WEBHOOK_ID or legacy PAYPAL_WEBHOOK_ID, PAYPAL_LIVE_WEBHOOK_ID) and/or Invoicing webhook ids (PAYPAL_SANDBOX_INVOICING_WEBHOOK_ID, PAYPAL_LIVE_INVOICING_WEBHOOK_ID) with matching client credentials"
            ),
            { status: 503, code: "PAYPAL_WEBHOOK_ID_MISSING" }
        );
    }

    const h = input.headers;
    const pick = (name: string) => {
        const v = h[name] ?? h[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    };
    const transmissionId = pick("paypal-transmission-id");
    const transmissionTime = pick("paypal-transmission-time");
    const certUrl = pick("paypal-cert-url");
    const authAlgo = pick("paypal-auth-algo");
    const transmissionSig = pick("paypal-transmission-sig");
    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
        return { verified: false, environment: null, reason: "missing_transmission_headers" };
    }
    let webhookEvent: unknown;
    try {
        webhookEvent = JSON.parse(input.rawBody);
    } catch {
        return { verified: false, environment: null, reason: "invalid_json" };
    }

    // Prefer cert-url hint (sandbox vs live host) but always fall back to the other env.
    const certHint: PayPalEnvironment | null = /sandbox/i.test(String(certUrl || ""))
        ? "sandbox"
        : /api\.paypal\.com|api-m\.paypal\.com/i.test(String(certUrl || ""))
          ? "live"
          : null;
    const rank = (t: PayPalWebhookTarget) => (certHint && t.environment === certHint ? 0 : 1);
    const ordered = [...capable].sort((a, b) => rank(a) - rank(b));

    for (const target of ordered) {
        try {
            const ok = await verifyWebhookAgainstTarget(target, {
                transmissionId,
                transmissionTime,
                certUrl,
                authAlgo,
                transmissionSig,
                webhookEvent,
            });
            if (ok) {
                return {
                    verified: true,
                    environment: target.environment,
                    webhookKind: target.webhookKind,
                };
            }
        } catch {
            // Try the other environment; do not leak tokens or secrets.
            continue;
        }
    }
    return { verified: false, environment: null, reason: "signature_mismatch" };
}

/** Back-compat boolean wrapper (active dual verification under the hood). */
export async function verifyPayPalWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
}): Promise<boolean> {
    const result = await verifyPayPalWebhookSignatureDetailed(input);
    return result.verified;
}

/** Test helper — clear cached OAuth tokens for one or all environments. */
export function clearPayPalTokenCache(environment?: PayPalEnvironment) {
    if (environment) {
        tokenCacheByEnv[environment] = null;
        return;
    }
    tokenCacheByEnv.sandbox = null;
    tokenCacheByEnv.live = null;
}

export { getPayPalEnv, getActivePayPalEnv };

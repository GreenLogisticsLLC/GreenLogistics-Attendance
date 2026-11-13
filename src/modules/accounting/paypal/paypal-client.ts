import { config } from "../../../config/env.js";

type TokenCache = {
    accessToken: string;
    expiresAtMs: number;
};

let tokenCache: TokenCache | null = null;

export type PayPalOrderResult = {
    id: string;
    status: string;
    approvalUrl: string | null;
    captureId: string | null;
    captureStatus: string | null;
    amountValue: string | null;
    currencyCode: string | null;
    raw: unknown;
};

export type PayPalCaptureResult = {
    id: string;
    status: string;
    captureId: string | null;
    captureStatus: string | null;
    amountValue: string | null;
    currencyCode: string | null;
    raw: unknown;
};

function apiBase(): string {
    return config.paypal.apiBaseUrl;
}

function assertConfigured() {
    if (!config.paypal.configured) {
        throw Object.assign(
            new Error(
                "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (PAYPAL_MODE=sandbox)."
            ),
            { status: 503, code: "PAYPAL_NOT_CONFIGURED" }
        );
    }
}

async function paypalFetch(path: string, init: RequestInit & { accessToken?: string } = {}) {
    assertConfigured();
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    if (init.accessToken) {
        headers.set("Authorization", `Bearer ${init.accessToken}`);
    }
    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${apiBase()}${path}`, {
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
            { status: 502, code: "PAYPAL_API_ERROR", paypalStatus: res.status, paypalBody: json }
        );
    }
    return json;
}

export async function getPayPalAccessToken(forceRefresh = false): Promise<string> {
    assertConfigured();
    const now = Date.now();
    if (!forceRefresh && tokenCache && tokenCache.expiresAtMs > now + 30_000) {
        return tokenCache.accessToken;
    }
    const basic = Buffer.from(
        `${config.paypal.clientId}:${config.paypal.clientSecret}`,
        "utf8"
    ).toString("base64");
    const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
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
                `PayPal OAuth failed: ${json.error_description || res.statusText || res.status}`
            ),
            { status: 502, code: "PAYPAL_OAUTH_FAILED" }
        );
    }
    const expiresIn = Number(json.expires_in) || 3200;
    tokenCache = {
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

export async function createPayPalOrder(input: {
    amountUsd: number;
    currency?: string;
    invoiceNumber?: string | null;
    description?: string;
    customId?: string;
    returnUrl?: string;
    cancelUrl?: string;
    idempotencyKey: string;
}): Promise<PayPalOrderResult> {
    const token = await getPayPalAccessToken();
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
                input.returnUrl ||
                `${config.publicAppUrl}/accounting?paypal=return`,
            cancel_url:
                input.cancelUrl ||
                `${config.publicAppUrl}/accounting?paypal=cancel`,
        },
    };
    const json = (await paypalFetch("/v2/checkout/orders", {
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
    };
}

export async function getPayPalOrder(paypalOrderId: string): Promise<PayPalOrderResult> {
    const token = await getPayPalAccessToken();
    const json = (await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
        method: "GET",
        accessToken: token,
    })) as {
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
    };
}

export async function capturePayPalOrder(
    paypalOrderId: string,
    captureRequestId: string
): Promise<PayPalCaptureResult> {
    const token = await getPayPalAccessToken();
    const json = (await paypalFetch(
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
    };
}

/** Official PayPal webhook signature verification. */
export async function verifyPayPalWebhookSignature(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
}): Promise<boolean> {
    assertConfigured();
    if (!config.paypal.webhookId) {
        throw Object.assign(
            new Error("PAYPAL_WEBHOOK_ID is not configured — cannot verify webhooks"),
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
        return false;
    }
    let webhookEvent: unknown;
    try {
        webhookEvent = JSON.parse(input.rawBody);
    } catch {
        return false;
    }
    const token = await getPayPalAccessToken();
    const json = (await paypalFetch("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        accessToken: token,
        body: JSON.stringify({
            transmission_id: transmissionId,
            transmission_time: transmissionTime,
            cert_url: certUrl,
            auth_algo: authAlgo,
            transmission_sig: transmissionSig,
            webhook_id: config.paypal.webhookId,
            webhook_event: webhookEvent,
        }),
    })) as { verification_status?: string };
    return String(json.verification_status || "").toUpperCase() === "SUCCESS";
}

/** Test helper — clear cached OAuth token. */
export function clearPayPalTokenCache() {
    tokenCache = null;
}

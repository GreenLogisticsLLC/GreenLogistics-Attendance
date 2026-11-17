/**
 * PayPal Invoicing API v2 client (https://developer.paypal.com/docs/api/invoicing/v2/).
 *
 * Distinct from Checkout Orders: invoice ids (INV2-…) are never Checkout order ids.
 * Reuses the dual-environment OAuth cache from paypal-client; credentials always
 * come from the environment passed in (PAYPAL_INVOICING_MODE decides the default,
 * never PAYPAL_MODE). Never logs tokens or secrets.
 */
import { getPayPalAccessToken, paypalFetch } from "./paypal-client.js";
import {
    assertInvoicingEnvConfigured,
    getActiveInvoicingEnv,
    type PayPalEnvironment,
} from "./paypal-env.js";

const REQUEST_TIMEOUT_MS = 30_000;

export type PayPalLink = { rel?: string; href?: string; method?: string };

export type PayPalMoney = { currency_code?: string; value?: string };

export type PayPalInvoiceResource = {
    id?: string;
    status?: string;
    detail?: {
        invoice_number?: string;
        reference?: string;
        invoice_date?: string;
        currency_code?: string;
        payment_term?: { term_type?: string; due_date?: string };
        metadata?: { recipient_view_url?: string; invoicer_view_url?: string };
    };
    amount?: PayPalMoney & { breakdown?: unknown };
    due_amount?: PayPalMoney;
    payments?: {
        paid_amount?: PayPalMoney;
        transactions?: Array<{
            payment_id?: string;
            amount?: PayPalMoney;
            type?: string;
            method?: string;
        }>;
    };
    primary_recipients?: unknown[];
    items?: unknown[];
    links?: PayPalLink[];
};

export type PayPalInvoiceSummary = {
    id: string | null;
    status: string;
    invoiceNumber: string | null;
    currency: string | null;
    totalValue: string | null;
    paidValue: string | null;
    paidCurrency: string | null;
    dueValue: string | null;
    dueDate: string | null;
    transactionId: string | null;
    hostedInvoiceUrl: string | null;
    selfHref: string | null;
};

export type PayPalInvoiceResult = {
    environment: PayPalEnvironment;
    summary: PayPalInvoiceSummary;
    raw: unknown;
};

function activeInvoicingEnvironment(environment?: PayPalEnvironment): PayPalEnvironment {
    return environment || getActiveInvoicingEnv().environment;
}

function findLink(links: PayPalLink[] | undefined, rel: string): string | null {
    const hit = (links || []).find((l) => String(l.rel || "").toLowerCase() === rel);
    return hit?.href ? String(hit.href) : null;
}

/** Invoice id is the last path segment of the invoice `self` href. */
export function invoiceIdFromHref(href: string | null | undefined): string | null {
    if (!href) return null;
    const match = /\/v2\/invoicing\/invoices\/([^/?#]+)/i.exec(href);
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Customer-facing hosted invoice URL. The API `self` link is an api-m.* URL that
 * is not payable by a customer, so it is exposed separately as `selfHref`.
 */
export function pickHostedInvoiceUrl(
    invoice: Pick<PayPalInvoiceResource, "links" | "detail"> | null | undefined,
    extraLinks?: PayPalLink[]
): string | null {
    const links = [...(extraLinks || []), ...(invoice?.links || [])];
    return (
        findLink(links, "payer-view") ||
        invoice?.detail?.metadata?.recipient_view_url ||
        null
    );
}

export function parsePayPalInvoice(raw: unknown): PayPalInvoiceSummary {
    const inv = (raw && typeof raw === "object" ? raw : {}) as PayPalInvoiceResource;
    const selfHref = findLink(inv.links, "self");
    const paid = inv.payments?.paid_amount;
    const firstTx = inv.payments?.transactions?.find((t) => t.payment_id);
    return {
        id: inv.id || invoiceIdFromHref(selfHref),
        status: String(inv.status || "").trim().toUpperCase(),
        invoiceNumber: inv.detail?.invoice_number || null,
        currency: inv.amount?.currency_code || inv.detail?.currency_code || null,
        totalValue: inv.amount?.value ?? null,
        paidValue: paid?.value ?? null,
        paidCurrency: paid?.currency_code ?? null,
        dueValue: inv.due_amount?.value ?? null,
        dueDate: inv.detail?.payment_term?.due_date || null,
        transactionId: firstTx?.payment_id || null,
        hostedInvoiceUrl: pickHostedInvoiceUrl(inv),
        selfHref,
    };
}

function usd(value: number): string {
    return (Math.round((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2);
}

/**
 * Calendar YYYY-MM-DD in a specific IANA timezone (not UTC-from-ISO).
 * PayPal schedules send when invoice_date is "in the future" in the merchant
 * account timezone — UTC date alone is not safe for immediate delivery.
 */
export function calendarDateInTimeZone(
    value: Date | string,
    timeZone: string
): string {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) {
        throw Object.assign(new Error("Invalid invoice date"), {
            status: 422,
            code: "PAYPAL_INVOICE_DATE_INVALID",
        });
    }
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timeZone || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(d);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (!year || !month || !day) {
        throw Object.assign(new Error("Invalid invoice date"), {
            status: 422,
            code: "PAYPAL_INVOICE_DATE_INVALID",
        });
    }
    return `${year}-${month}-${day}`;
}

function isoDate(value: Date | string, timeZone = "UTC"): string {
    return calendarDateInTimeZone(value, timeZone);
}

/**
 * Issue date that PayPal will treat as "today or past" for immediate send.
 * Merchant PayPal profile timezone can lag UTC by up to 12h, so use UTC yesterday.
 */
export function immediateInvoiceIssueDate(now = new Date()): string {
    const safe = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return calendarDateInTimeZone(safe, "UTC");
}

/** True when YYYY-MM-DD `a` is strictly after `b`. */
export function isCalendarDateAfter(a: string, b: string): boolean {
    return String(a || "") > String(b || "");
}

export type PayPalInvoiceItemInput = {
    name: string;
    quantity?: number;
    unitAmount: number;
    description?: string;
};

export type BuildPayPalInvoicePayloadInput = {
    invoiceNumber: string;
    invoiceDate: Date | string;
    dueDate: Date | string;
    currency?: string;
    customerName?: string | null;
    customerEmail?: string | null;
    items: PayPalInvoiceItemInput[];
    note?: string | null;
    reference?: string | null;
    /** IANA zone for calendar dates. Default UTC; prefer business timezone on create. */
    timeZone?: string;
};

/**
 * Draft invoice body for POST /v2/invoicing/invoices. Partial payments, tips and
 * tax are disabled so the PayPal total always equals the GreenOS invoice total.
 */
export function buildPayPalInvoicePayload(input: BuildPayPalInvoicePayloadInput) {
    const currency = String(input.currency || "USD").toUpperCase();
    if (!input.items.length) {
        throw Object.assign(new Error("PayPal invoice needs at least one line item"), {
            status: 422,
            code: "PAYPAL_INVOICE_ITEMS_REQUIRED",
        });
    }
    const items = input.items.map((item) => {
        const quantity = item.quantity ?? 1;
        if (!Number.isFinite(item.unitAmount) || item.unitAmount < 0) {
            throw Object.assign(new Error("PayPal invoice line amount is invalid"), {
                status: 422,
                code: "PAYPAL_INVOICE_AMOUNT_INVALID",
            });
        }
        return {
            name: String(item.name).slice(0, 200),
            ...(item.description ? { description: String(item.description).slice(0, 1000) } : {}),
            quantity: String(quantity),
            unit_amount: { currency_code: currency, value: usd(item.unitAmount) },
            unit_of_measure: "QUANTITY",
        };
    });
    const email = String(input.customerEmail || "").trim();
    const name = String(input.customerName || "").trim();
    const timeZone = input.timeZone || "UTC";
    const billingInfo: Record<string, unknown> = {};
    if (name) billingInfo.business_name = name.slice(0, 300);
    if (email) billingInfo.email_address = email;
    // Prefer an issue date that will not schedule-send across merchant timezones.
    // Callers that need a specific calendar date can pass a past Date; send() also
    // rewrites the issue date immediately before /send.
    const invoiceDate = isoDate(input.invoiceDate, timeZone);
    let dueDate = isoDate(input.dueDate, timeZone);
    if (dueDate < invoiceDate) dueDate = invoiceDate;
    return {
        detail: {
            invoice_number: String(input.invoiceNumber).slice(0, 25),
            ...(input.reference ? { reference: String(input.reference).slice(0, 120) } : {}),
            invoice_date: invoiceDate,
            currency_code: currency,
            ...(input.note ? { note: String(input.note).slice(0, 4000) } : {}),
            payment_term: {
                term_type: "DUE_ON_DATE_SPECIFIED",
                due_date: dueDate,
            },
        },
        primary_recipients: [{ billing_info: billingInfo }],
        items,
        configuration: {
            partial_payment: { allow_partial_payment: false },
            allow_tip: false,
            tax_calculated_after_discount: true,
            tax_inclusive: false,
        },
    };
}

async function invoicingFetch(
    environment: PayPalEnvironment,
    path: string,
    init: {
        method: "GET" | "POST" | "PUT" | "DELETE";
        body?: unknown;
        requestId?: string;
        preferRepresentation?: boolean;
    }
) {
    const env = assertInvoicingEnvConfigured(environment);
    const token = await getPayPalAccessToken(environment);
    const headers: Record<string, string> = {};
    if (init.requestId) headers["PayPal-Request-Id"] = init.requestId;
    if (init.preferRepresentation) headers.Prefer = "return=representation";
    return paypalFetch(env, path, {
        method: init.method,
        accessToken: token,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

function invoicePath(id: string, suffix = ""): string {
    const clean = String(id || "").trim();
    if (!clean) {
        throw Object.assign(new Error("PayPal invoice id is required"), {
            status: 422,
            code: "PAYPAL_INVOICE_ID_MISSING",
        });
    }
    return `/v2/invoicing/invoices/${encodeURIComponent(clean)}${suffix}`;
}

export async function createDraftInvoice(input: {
    environment?: PayPalEnvironment;
    /** Stable PayPal-Request-Id; reuse on every retry of the same logical create. */
    idempotencyKey: string;
    body: unknown;
}): Promise<{ id: string; environment: PayPalEnvironment; hrefSelf: string | null; raw: unknown }> {
    const environment = activeInvoicingEnvironment(input.environment);
    const json = (await invoicingFetch(environment, "/v2/invoicing/invoices", {
        method: "POST",
        requestId: input.idempotencyKey,
        body: input.body,
    })) as PayPalInvoiceResource & PayPalLink;
    const hrefSelf = json?.href || findLink(json?.links, "self");
    const id = json?.id || invoiceIdFromHref(hrefSelf);
    if (!id) {
        throw Object.assign(new Error("PayPal did not return an invoice id"), {
            status: 502,
            code: "PAYPAL_INVOICE_ID_MISSING",
            paypalEnvironment: environment,
        });
    }
    return { id, environment, hrefSelf: hrefSelf || null, raw: json };
}

export async function getInvoice(
    id: string,
    environment?: PayPalEnvironment
): Promise<PayPalInvoiceResult> {
    const env = activeInvoicingEnvironment(environment);
    const raw = await invoicingFetch(env, invoicePath(id), { method: "GET" });
    return { environment: env, summary: parsePayPalInvoice(raw), raw };
}

export async function updateDraftInvoice(
    id: string,
    body: unknown,
    environment?: PayPalEnvironment
): Promise<PayPalInvoiceResult> {
    const env = activeInvoicingEnvironment(environment);
    await invoicingFetch(env, invoicePath(id, "?send_to_recipient=false"), {
        method: "PUT",
        body,
    });
    return getInvoice(id, env);
}

/**
 * Rewrite invoice_date so PayPal /send delivers immediately instead of SCHEDULED.
 * Official rule: future issue date → schedule; today/past → email now.
 * Returns the updated GET result (or original when already safe).
 */
export async function ensureInvoiceIssueDateForImmediateSend(
    id: string,
    environment?: PayPalEnvironment,
    now = new Date()
): Promise<PayPalInvoiceResult> {
    const env = activeInvoicingEnvironment(environment);
    const current = await getInvoice(id, env);
    const status = current.summary.status;
    if (status !== "DRAFT" && status !== "SCHEDULED") {
        return current;
    }
    const raw = (current.raw && typeof current.raw === "object" ? current.raw : {}) as Record<
        string,
        unknown
    >;
    const detail =
        raw.detail && typeof raw.detail === "object"
            ? ({ ...(raw.detail as Record<string, unknown>) } as Record<string, unknown>)
            : {};
    // Always pin to a past UTC date before send so merchant-TZ lag cannot schedule.
    const safeIssueDate = immediateInvoiceIssueDate(now);
    detail.invoice_date = safeIssueDate;
    const paymentTerm =
        detail.payment_term && typeof detail.payment_term === "object"
            ? ({ ...(detail.payment_term as Record<string, unknown>) } as Record<string, unknown>)
            : { term_type: "DUE_ON_DATE_SPECIFIED" };
    const due = String(paymentTerm.due_date || "").slice(0, 10);
    if (!due || due < safeIssueDate) {
        paymentTerm.due_date = safeIssueDate;
    }
    detail.payment_term = paymentTerm;

    // PayPal fully-update expects the editable invoice fields (not read-only links/id/status).
    const body: Record<string, unknown> = {
        detail,
        primary_recipients: raw.primary_recipients,
        items: raw.items,
        configuration: raw.configuration,
    };
    if (raw.invoicer) body.invoicer = raw.invoicer;
    if (raw.amount) body.amount = raw.amount;

    return updateDraftInvoice(id, body, env);
}

/** DRAFT invoices cannot be cancelled in PayPal — they are deleted. */
export async function deleteDraftInvoice(
    id: string,
    environment?: PayPalEnvironment
): Promise<{ environment: PayPalEnvironment }> {
    const env = activeInvoicingEnvironment(environment);
    await invoicingFetch(env, invoicePath(id), { method: "DELETE" });
    return { environment: env };
}

export type PayPalInvoiceSendBody = {
    subject?: string;
    note?: string;
    send_to_invoicer?: boolean;
    send_to_recipient?: boolean;
    additional_recipients?: string[];
};

export async function sendInvoice(
    id: string,
    environment?: PayPalEnvironment,
    requestId?: string,
    body?: PayPalInvoiceSendBody
): Promise<{ environment: PayPalEnvironment; hostedInvoiceUrl: string | null; raw: unknown }> {
    const env = activeInvoicingEnvironment(environment);
    const raw = (await invoicingFetch(env, invoicePath(id, "/send"), {
        method: "POST",
        requestId,
        body: { send_to_recipient: true, send_to_invoicer: false, ...(body || {}) },
    })) as PayPalLink | { links?: PayPalLink[] } | null;
    const links = Array.isArray((raw as { links?: PayPalLink[] } | null)?.links)
        ? (raw as { links: PayPalLink[] }).links
        : raw && typeof raw === "object" && "rel" in raw
          ? [raw as PayPalLink]
          : [];
    return { environment: env, hostedInvoiceUrl: findLink(links, "payer-view"), raw };
}

export async function cancelInvoice(
    id: string,
    environment?: PayPalEnvironment,
    body?: PayPalInvoiceSendBody,
    requestId?: string
): Promise<{ environment: PayPalEnvironment }> {
    const env = activeInvoicingEnvironment(environment);
    await invoicingFetch(env, invoicePath(id, "/cancel"), {
        method: "POST",
        requestId,
        body: { send_to_recipient: true, send_to_invoicer: false, ...(body || {}) },
    });
    return { environment: env };
}

export async function remindInvoice(
    id: string,
    environment?: PayPalEnvironment,
    body?: Omit<PayPalInvoiceSendBody, "send_to_recipient">,
    requestId?: string
): Promise<{ environment: PayPalEnvironment }> {
    const env = activeInvoicingEnvironment(environment);
    await invoicingFetch(env, invoicePath(id, "/remind"), {
        method: "POST",
        requestId,
        body: { send_to_invoicer: false, ...(body || {}) },
    });
    return { environment: env };
}

export type PayPalInvoiceSearchBody = {
    invoice_number?: string;
    recipient_email?: string;
    status?: string[];
    reference?: string;
    currency_code?: string;
    total_amount_range?: {
        lower_amount: PayPalMoney;
        upper_amount: PayPalMoney;
    };
    [key: string]: unknown;
};

export async function searchInvoices(
    body: PayPalInvoiceSearchBody,
    environment?: PayPalEnvironment,
    paging: { page?: number; pageSize?: number } = {}
): Promise<{
    environment: PayPalEnvironment;
    totalItems: number;
    items: PayPalInvoiceSummary[];
    raw: unknown;
}> {
    const env = activeInvoicingEnvironment(environment);
    const page = Math.max(1, Math.floor(paging.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(paging.pageSize || 20)));
    const raw = (await invoicingFetch(
        env,
        `/v2/invoicing/search-invoices?page=${page}&page_size=${pageSize}&total_required=true`,
        { method: "POST", body }
    )) as { total_items?: number; items?: unknown[] } | null;
    const items = Array.isArray(raw?.items) ? raw!.items!.map(parsePayPalInvoice) : [];
    return {
        environment: env,
        totalItems: Number(raw?.total_items ?? items.length),
        items,
        raw,
    };
}

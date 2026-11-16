import { config } from "../../../config/env.js";

export type PayPalEnvironment = "sandbox" | "live";

export type PayPalEnvCredentials = {
    environment: PayPalEnvironment;
    clientId: string;
    clientSecret: string;
    webhookId: string;
    /** Webhook id registered for INVOICING.* events in this environment. */
    invoicingWebhookId: string;
    apiBaseUrl: string;
    configured: boolean;
    webhookConfigured: boolean;
    invoicingWebhookConfigured: boolean;
};

export type PayPalWebhookKind = "checkout" | "invoicing";

export type PayPalWebhookTarget = {
    environment: PayPalEnvironment;
    clientId: string;
    clientSecret: string;
    webhookId: string;
    apiBaseUrl: string;
    configured: boolean;
    webhookKind: PayPalWebhookKind;
};

export function paypalApiBaseFor(environment: PayPalEnvironment): string {
    return environment === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com";
}

/** Credentials for one environment — never mixes Sandbox and LIVE. */
export function getPayPalEnv(environment: PayPalEnvironment): PayPalEnvCredentials {
    return environment === "live" ? config.paypal.live : config.paypal.sandbox;
}

/** Active Checkout environment from PAYPAL_MODE (default sandbox). */
export function getActivePayPalEnv(): PayPalEnvCredentials {
    return config.paypal.active;
}

export function listWebhookCapablePayPalEnvs(): PayPalEnvCredentials[] {
    return [config.paypal.sandbox, config.paypal.live].filter((env) => env.webhookConfigured);
}

/**
 * Active Invoicing environment from PAYPAL_INVOICING_MODE (default sandbox).
 * Independent of PAYPAL_MODE — uses the same client credentials as that env.
 */
export function getActiveInvoicingEnv(): PayPalEnvCredentials {
    return config.paypal.invoicingActive;
}

/**
 * Every configured webhook (Checkout + Invoicing, Sandbox + LIVE) with the
 * credentials of its own environment. Never mixes environments.
 */
export function listWebhookCapablePayPalTargets(): PayPalWebhookTarget[] {
    const targets: PayPalWebhookTarget[] = [];
    for (const env of [config.paypal.sandbox, config.paypal.live]) {
        const base = {
            environment: env.environment,
            clientId: env.clientId,
            clientSecret: env.clientSecret,
            apiBaseUrl: env.apiBaseUrl,
            configured: env.configured,
        };
        if (env.webhookConfigured) {
            targets.push({ ...base, webhookId: env.webhookId, webhookKind: "checkout" });
        }
        if (env.invoicingWebhookConfigured) {
            targets.push({ ...base, webhookId: env.invoicingWebhookId, webhookKind: "invoicing" });
        }
    }
    return targets;
}

export function assertInvoicingEnvConfigured(
    environment: PayPalEnvironment = getActiveInvoicingEnv().environment
) {
    const env = getPayPalEnv(environment);
    if (!env.configured) {
        const hint =
            environment === "live"
                ? "Set PAYPAL_LIVE_CLIENT_ID and PAYPAL_LIVE_CLIENT_SECRET (PAYPAL_INVOICING_MODE=live)."
                : "Set PAYPAL_SANDBOX_CLIENT_ID/SECRET or legacy PAYPAL_CLIENT_ID/SECRET (PAYPAL_INVOICING_MODE=sandbox).";
        throw Object.assign(
            new Error(`PayPal Invoicing (${environment}) is not configured. ${hint}`),
            {
                status: 503,
                code: "PAYPAL_INVOICING_NOT_CONFIGURED",
                paypalEnvironment: environment,
            }
        );
    }
    return env;
}

export function assertPayPalEnvConfigured(environment: PayPalEnvironment = getActivePayPalEnv().environment) {
    const env = getPayPalEnv(environment);
    if (!env.configured) {
        const hint =
            environment === "live"
                ? "Set PAYPAL_LIVE_CLIENT_ID and PAYPAL_LIVE_CLIENT_SECRET (PAYPAL_MODE=live)."
                : "Set PAYPAL_SANDBOX_CLIENT_ID/SECRET or legacy PAYPAL_CLIENT_ID/SECRET (PAYPAL_MODE=sandbox).";
        throw Object.assign(new Error(`PayPal ${environment} is not configured. ${hint}`), {
            status: 503,
            code: "PAYPAL_NOT_CONFIGURED",
            paypalEnvironment: environment,
        });
    }
    return env;
}

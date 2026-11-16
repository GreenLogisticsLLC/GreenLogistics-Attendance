import { config } from "../../../config/env.js";

export type PayPalEnvironment = "sandbox" | "live";

export type PayPalEnvCredentials = {
    environment: PayPalEnvironment;
    clientId: string;
    clientSecret: string;
    webhookId: string;
    apiBaseUrl: string;
    configured: boolean;
    webhookConfigured: boolean;
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

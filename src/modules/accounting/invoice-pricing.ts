/**
 * Invoice Pricing — administrator-configurable handling fee for customer invoices.
 *
 * Compliance rules encoded here:
 * - Default DISABLED until an Owner/Administrator enables it with policy acknowledgment.
 * - Fee is a handling fee, NEVER a PayPal / payment-method surcharge.
 * - When enabled, the same fee policy applies to every customer payment method.
 * - Historical invoices lock a pricing snapshot and do not change when settings change.
 *
 * This is GreenOS invoice / Checkout pricing — not the PayPal Invoicing API.
 */

import { prisma } from "../../config/database.js";

export const INVOICE_PRICING_CATEGORY = "accounting";
export const INVOICE_PRICING_SETTING_KEY = "invoice_pricing";

export const INVOICE_PRICING_POLICY_TEXT =
    "I confirm this additional fee is a lawful handling fee applied consistently across " +
    "eligible payment methods. It is not a PayPal surcharge, not a fee specifically for " +
    "choosing PayPal, and does not exceed the comparable handling fee charged for " +
    "non-PayPal transactions. I understand PayPal User Agreement and applicable law " +
    "restrictions on payment-method surcharges.";

export type InvoiceFeeType = "none" | "percentage" | "fixed";

export type InvoicePricingSettings = {
    /** Monotonic policy version; increments on every successful save. */
    version: number;
    enabled: boolean;
    feeType: InvoiceFeeType;
    /** Percentage points (e.g. 3 = 3%). Used when feeType=percentage. */
    percentageValue: number;
    /** Fixed USD amount. Used when feeType=fixed. */
    fixedAmountUsd: number;
    /** Always true when enabled — method-neutral handling fee. */
    applyToAllMethods: true;
    lineItemLabel: string;
    policyAcknowledgedAt: string | null;
    policyAcknowledgedByUserId: string | null;
    updatedAt: string | null;
    updatedByUserId: string | null;
};

export type InvoicePricingSnapshot = {
    version: number;
    enabled: boolean;
    feeType: InvoiceFeeType;
    configuredValue: number;
    feeAmountUsd: number;
    subtotalUsd: number;
    totalUsd: number;
    currency: "USD";
    lineItemLabel: string;
    waived: boolean;
    capturedAt: string;
};

export type InvoicePricingBreakdown = {
    currency: "USD";
    rateUsd: number | null;
    accessorialsUsd: number;
    subtotalUsd: number | null;
    feeType: InvoiceFeeType;
    configuredValue: number;
    feeAmountUsd: number;
    totalUsd: number | null;
    waived: boolean;
    enabled: boolean;
    pricingVersion: number;
    lineItemLabel: string;
    lineItems: Array<{
        code: "SUBTOTAL" | "HANDLING_FEE" | "TOTAL";
        label: string;
        amountUsd: number;
    }>;
};

const DEFAULT_SETTINGS: InvoicePricingSettings = {
    version: 1,
    enabled: false,
    feeType: "none",
    percentageValue: 0,
    fixedAmountUsd: 0,
    applyToAllMethods: true,
    lineItemLabel: "Handling fee",
    policyAcknowledgedAt: null,
    policyAcknowledgedByUserId: null,
    updatedAt: null,
    updatedByUserId: null,
};

function money(value: unknown): number {
    if (value == null || value === "") return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function hasAmount(value: unknown): boolean {
    if (value == null || value === "") return false;
    return Number.isFinite(typeof value === "number" ? value : Number(value));
}

/** Banker's-avoidant half-up to cents. */
export function roundUsd(value: number): number {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function defaultInvoicePricingSettings(): InvoicePricingSettings {
    return { ...DEFAULT_SETTINGS };
}

function normalizeFeeType(value: unknown): InvoiceFeeType {
    const raw = String(value || "")
        .trim()
        .toLowerCase();
    if (raw === "percentage" || raw === "percent" || raw === "pct") return "percentage";
    if (raw === "fixed" || raw === "flat") return "fixed";
    return "none";
}

export function parseInvoicePricingSettings(raw: unknown): InvoicePricingSettings {
    const base = defaultInvoicePricingSettings();
    if (!raw || typeof raw !== "object") return base;
    const row = raw as Record<string, unknown>;
    const feeType = normalizeFeeType(row.feeType ?? row.fee_type);
    const percentageValue = Math.max(0, money(row.percentageValue ?? row.percentage_value));
    const fixedAmountUsd = Math.max(0, roundUsd(money(row.fixedAmountUsd ?? row.fixed_amount_usd)));
    const enabled = Boolean(row.enabled) && feeType !== "none";
    const version = Math.max(1, Math.floor(money(row.version) || 1));
    const label = String(row.lineItemLabel || row.line_item_label || base.lineItemLabel)
        .trim()
        .slice(0, 80);
    // Reject PayPal-surcharge style labels.
    const safeLabel = /paypal/i.test(label) ? base.lineItemLabel : label || base.lineItemLabel;
    return {
        version,
        enabled,
        feeType: enabled ? feeType : "none",
        percentageValue,
        fixedAmountUsd,
        applyToAllMethods: true,
        lineItemLabel: safeLabel,
        policyAcknowledgedAt: row.policyAcknowledgedAt
            ? String(row.policyAcknowledgedAt)
            : row.policy_acknowledged_at
              ? String(row.policy_acknowledged_at)
              : null,
        policyAcknowledgedByUserId: row.policyAcknowledgedByUserId
            ? String(row.policyAcknowledgedByUserId)
            : row.policy_acknowledged_by_user_id
              ? String(row.policy_acknowledged_by_user_id)
              : null,
        updatedAt: row.updatedAt ? String(row.updatedAt) : null,
        updatedByUserId: row.updatedByUserId ? String(row.updatedByUserId) : null,
    };
}

export async function loadInvoicePricingSettings(): Promise<InvoicePricingSettings> {
    const row = await prisma.setting.findUnique({
        where: {
            category_settingKey: {
                category: INVOICE_PRICING_CATEGORY,
                settingKey: INVOICE_PRICING_SETTING_KEY,
            },
        },
    });
    if (!row?.settingValue) return defaultInvoicePricingSettings();
    try {
        return parseInvoicePricingSettings(JSON.parse(row.settingValue));
    } catch {
        return defaultInvoicePricingSettings();
    }
}

export function configuredFeeValue(settings: InvoicePricingSettings): number {
    if (!settings.enabled || settings.feeType === "none") return 0;
    if (settings.feeType === "percentage") return settings.percentageValue;
    return settings.fixedAmountUsd;
}

export function calculateHandlingFeeUsd(input: {
    settings: InvoicePricingSettings;
    subtotalUsd: number;
    waiveFee?: boolean | null;
}): number {
    if (input.waiveFee) return 0;
    if (!input.settings.enabled || input.settings.feeType === "none") return 0;
    if (input.settings.feeType === "percentage") {
        return roundUsd(input.subtotalUsd * (input.settings.percentageValue / 100));
    }
    return roundUsd(input.settings.fixedAmountUsd);
}

/**
 * Build a live pricing breakdown from current settings (or a locked snapshot).
 * Fee is method-neutral — payment method does not change the fee.
 */
export function buildInvoicePricingBreakdown(input: {
    customerRate?: unknown;
    accessorialCharges?: unknown;
    waiveFee?: boolean | null;
    settings: InvoicePricingSettings;
    snapshot?: InvoicePricingSnapshot | null;
}): InvoicePricingBreakdown {
    if (input.snapshot) {
        const snap = input.snapshot;
        const lineItems: InvoicePricingBreakdown["lineItems"] = [
            {
                code: "SUBTOTAL",
                label: "Subtotal",
                amountUsd: snap.subtotalUsd,
            },
        ];
        if (snap.feeAmountUsd > 0) {
            lineItems.push({
                code: "HANDLING_FEE",
                label: snap.lineItemLabel || "Handling fee",
                amountUsd: snap.feeAmountUsd,
            });
        }
        lineItems.push({
            code: "TOTAL",
            label: "Total",
            amountUsd: snap.totalUsd,
        });
        return {
            currency: "USD",
            rateUsd: null,
            accessorialsUsd: 0,
            subtotalUsd: snap.subtotalUsd,
            feeType: snap.feeType,
            configuredValue: snap.configuredValue,
            feeAmountUsd: snap.feeAmountUsd,
            totalUsd: snap.totalUsd,
            waived: snap.waived,
            enabled: snap.enabled,
            pricingVersion: snap.version,
            lineItemLabel: snap.lineItemLabel || "Handling fee",
            lineItems,
        };
    }

    const knownRate = hasAmount(input.customerRate);
    const rateUsd = knownRate ? money(input.customerRate) : null;
    const accessorialsUsd = roundUsd(money(input.accessorialCharges));
    const subtotalUsd =
        rateUsd == null && !accessorialsUsd ? null : roundUsd((rateUsd || 0) + accessorialsUsd);
    const waived = Boolean(input.waiveFee && input.settings.enabled);
    const feeAmountUsd =
        subtotalUsd == null
            ? 0
            : calculateHandlingFeeUsd({
                  settings: input.settings,
                  subtotalUsd,
                  waiveFee: input.waiveFee,
              });
    const totalUsd = subtotalUsd == null ? null : roundUsd(subtotalUsd + feeAmountUsd);
    const feeType =
        !input.settings.enabled || waived ? "none" : input.settings.feeType;
    const configuredValue =
        feeType === "none" ? 0 : configuredFeeValue(input.settings);

    const lineItems: InvoicePricingBreakdown["lineItems"] = [];
    if (subtotalUsd != null) {
        lineItems.push({ code: "SUBTOTAL", label: "Subtotal", amountUsd: subtotalUsd });
    }
    if (feeAmountUsd > 0) {
        lineItems.push({
            code: "HANDLING_FEE",
            label: input.settings.lineItemLabel || "Handling fee",
            amountUsd: feeAmountUsd,
        });
    }
    if (totalUsd != null) {
        lineItems.push({ code: "TOTAL", label: "Total", amountUsd: totalUsd });
    }

    return {
        currency: "USD",
        rateUsd,
        accessorialsUsd,
        subtotalUsd,
        feeType,
        configuredValue,
        feeAmountUsd,
        totalUsd,
        waived,
        enabled: Boolean(input.settings.enabled),
        pricingVersion: input.settings.version,
        lineItemLabel: input.settings.lineItemLabel || "Handling fee",
        lineItems,
    };
}

export function createInvoicePricingSnapshot(input: {
    settings: InvoicePricingSettings;
    breakdown: InvoicePricingBreakdown;
    now?: Date;
}): InvoicePricingSnapshot {
    const b = input.breakdown;
    return {
        version: input.settings.version,
        enabled: input.settings.enabled,
        feeType: b.feeType,
        configuredValue: b.configuredValue,
        feeAmountUsd: b.feeAmountUsd,
        subtotalUsd: b.subtotalUsd ?? 0,
        totalUsd: b.totalUsd ?? 0,
        currency: "USD",
        lineItemLabel: b.lineItemLabel,
        waived: b.waived,
        capturedAt: (input.now || new Date()).toISOString(),
    };
}

export function parseInvoicePricingSnapshot(raw: unknown): InvoicePricingSnapshot | null {
    if (!raw) return null;
    let data = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!data || typeof data !== "object") return null;
    const row = data as Record<string, unknown>;
    const feeType = normalizeFeeType(row.feeType);
    return {
        version: Math.max(1, Math.floor(money(row.version) || 1)),
        enabled: Boolean(row.enabled),
        feeType,
        configuredValue: money(row.configuredValue),
        feeAmountUsd: roundUsd(money(row.feeAmountUsd)),
        subtotalUsd: roundUsd(money(row.subtotalUsd)),
        totalUsd: roundUsd(money(row.totalUsd)),
        currency: "USD",
        lineItemLabel: String(row.lineItemLabel || "Handling fee").slice(0, 80),
        waived: Boolean(row.waived),
        capturedAt: String(row.capturedAt || new Date().toISOString()),
    };
}

export type InvoicePricingUpdateInput = {
    enabled?: boolean;
    feeType?: InvoiceFeeType | string;
    percentageValue?: number;
    fixedAmountUsd?: number;
    lineItemLabel?: string;
    /** Required true when enabling a fee for the first time / re-enabling. */
    acknowledgePolicy?: boolean;
};

export function validateInvoicePricingUpdate(
    current: InvoicePricingSettings,
    input: InvoicePricingUpdateInput,
    actorUserId: string
): { ok: true; next: InvoicePricingSettings } | { ok: false; code: string; message: string } {
    const feeType = normalizeFeeType(input.feeType ?? current.feeType);
    const percentageValue = Math.max(
        0,
        money(input.percentageValue ?? current.percentageValue)
    );
    const fixedAmountUsd = Math.max(
        0,
        roundUsd(money(input.fixedAmountUsd ?? current.fixedAmountUsd))
    );
    let enabled = input.enabled != null ? Boolean(input.enabled) : current.enabled;

    if (enabled && feeType === "none") {
        return {
            ok: false,
            code: "INVOICE_PRICING_FEE_TYPE_REQUIRED",
            message: "Choose percentage or fixed before enabling the handling fee",
        };
    }
    if (enabled && feeType === "percentage" && percentageValue <= 0) {
        return {
            ok: false,
            code: "INVOICE_PRICING_PERCENT_REQUIRED",
            message: "Percentage value must be greater than zero",
        };
    }
    if (enabled && feeType === "percentage" && percentageValue > 100) {
        return {
            ok: false,
            code: "INVOICE_PRICING_PERCENT_TOO_HIGH",
            message: "Percentage value cannot exceed 100",
        };
    }
    if (enabled && feeType === "fixed" && fixedAmountUsd <= 0) {
        return {
            ok: false,
            code: "INVOICE_PRICING_FIXED_REQUIRED",
            message: "Fixed amount must be greater than zero",
        };
    }

    if (!enabled) {
        // Disabled is always allowed without acknowledgment.
    } else {
        const alreadyAcked = Boolean(current.policyAcknowledgedAt);
        const acknowledging = Boolean(input.acknowledgePolicy);
        if (!alreadyAcked && !acknowledging) {
            return {
                ok: false,
                code: "INVOICE_PRICING_POLICY_REQUIRED",
                message:
                    "Administrator must acknowledge the lawful pricing policy before enabling any additional fee",
            };
        }
    }

    const labelRaw = String(
        (input.lineItemLabel ?? current.lineItemLabel) || "Handling fee"
    )
        .trim()
        .slice(0, 80);
    if (/paypal/i.test(labelRaw) || /surcharge/i.test(labelRaw)) {
        return {
            ok: false,
            code: "INVOICE_PRICING_LABEL_FORBIDDEN",
            message:
                "Line item must not describe a PayPal surcharge or payment-method surcharge",
        };
    }

    const nowIso = new Date().toISOString();
    const next: InvoicePricingSettings = {
        version: current.version + 1,
        enabled: enabled && feeType !== "none",
        feeType: enabled ? feeType : "none",
        percentageValue,
        fixedAmountUsd,
        applyToAllMethods: true,
        lineItemLabel: labelRaw || "Handling fee",
        policyAcknowledgedAt:
            enabled && (input.acknowledgePolicy || current.policyAcknowledgedAt)
                ? input.acknowledgePolicy
                    ? nowIso
                    : current.policyAcknowledgedAt
                : current.policyAcknowledgedAt,
        policyAcknowledgedByUserId:
            enabled && input.acknowledgePolicy
                ? actorUserId
                : current.policyAcknowledgedByUserId,
        updatedAt: nowIso,
        updatedByUserId: actorUserId,
    };
    return { ok: true, next };
}

export async function saveInvoicePricingSettings(
    settings: InvoicePricingSettings,
    updatedByUserId: string
): Promise<InvoicePricingSettings> {
    const payload = {
        ...settings,
        applyToAllMethods: true as const,
        updatedAt: new Date().toISOString(),
        updatedByUserId,
    };
    await prisma.setting.upsert({
        where: {
            category_settingKey: {
                category: INVOICE_PRICING_CATEGORY,
                settingKey: INVOICE_PRICING_SETTING_KEY,
            },
        },
        create: {
            category: INVOICE_PRICING_CATEGORY,
            settingKey: INVOICE_PRICING_SETTING_KEY,
            settingValue: JSON.stringify(payload),
            description:
                "Invoice handling-fee policy (method-neutral; disabled by default)",
            updatedBy: updatedByUserId,
        },
        update: {
            settingValue: JSON.stringify(payload),
            updatedBy: updatedByUserId,
        },
    });
    return payload;
}

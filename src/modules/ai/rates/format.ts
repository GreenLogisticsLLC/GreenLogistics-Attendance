import type { MarketRateCompositeResult } from "./provider-types.js";
import type { MarketRateResult } from "./types.js";

function fmtMoney(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return "—";
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtRpm(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return "—";
    return `$${n.toFixed(2)}`;
}

function comparisonLabel(level: string | null): string {
    switch (level) {
        case "EXACT_ZIP_LANE":
            return "Exact ZIP lane + equipment";
        case "LANE_EQUIPMENT":
            return "Same lane + equipment";
        case "REGIONAL":
            return "Regional lane + equipment";
        default:
            return "—";
    }
}

function assessmentLabel(a: string | null): string {
    switch (a) {
        case "ABOVE_HISTORICAL_P75":
            return "Above historical P75 (statistical comparison — not an overcharge claim)";
        case "BELOW_HISTORICAL_P25":
            return "Below historical P25";
        case "WITHIN_HISTORICAL_RANGE":
            return "Within historical P25–P75 range";
        default:
            return "";
    }
}

function providerStatusLabel(status: string | undefined): string {
    switch (status) {
        case "NOT_CONFIGURED":
            return "Not connected";
        case "CONFIGURED":
            return "Configured (not live)";
        case "AVAILABLE":
            return "Available";
        case "UNAVAILABLE":
            return "Unavailable";
        case "ERROR":
            return "Error";
        case "TIMEOUT":
            return "Timeout";
        default:
            return status || "—";
    }
}

function formatInternalSection(result: MarketRateResult): string[] {
    const lines: string[] = [];
    lines.push("GreenOS Historical:");
    lines.push(`Comparable shipments: ${result.sampleSize}`);
    lines.push(`Comparison: ${comparisonLabel(result.comparisonLevel)}`);
    if (result.rpm) {
        lines.push(
            `RPM P25 ${fmtRpm(result.rpm.p25)} · Med ${fmtRpm(result.rpm.median)} · P75 ${fmtRpm(result.rpm.p75)}`
        );
    }
    if (result.rate) {
        lines.push(`Rate range ${fmtMoney(result.rate.p25)} – ${fmtMoney(result.rate.p75)}`);
    }
    if (result.recommendedTarget != null) {
        lines.push(`Internal historical target: ${fmtMoney(result.recommendedTarget)}`);
    }
    lines.push(`Confidence: ${result.confidence || "—"}`);
    if (result.recencyNote) lines.push(result.recencyNote);
    return lines;
}

export function formatMarketRateForChat(result: MarketRateCompositeResult): string {
    if (result.status === "FORBIDDEN") {
        return "Access denied.";
    }
    if (result.status === "NOT_FOUND") {
        return "I could not find this shipment in GreenOS.";
    }
    if (result.status === "MISSING_MILES") {
        return "Missing miles — cannot calculate RPM from GreenOS data. No rate was invented.";
    }
    if (result.status === "INSUFFICIENT_DATA") {
        const providerNotes = result.providers
            .filter((p) => p.providerId !== "INTERNAL_HISTORICAL")
            .map((p) => `${p.source}: ${providerStatusLabel(p.lifecycleStatus)}`);
        const lines = [
            result.message ||
                "Insufficient GreenOS historical data to calculate a reliable estimate.",
        ];
        if (providerNotes.length) {
            lines.push("");
            lines.push("External providers:");
            providerNotes.forEach((n) => lines.push(`- ${n}`));
        }
        return lines.join("\n");
    }

    const lines: string[] = [];
    lines.push("Market rate analysis:");
    lines.push("");
    lines.push(...formatInternalSection(result));
    lines.push("");
    lines.push("Important: GreenOS historical data is separate from external market providers.");

    const dat = result.providers.find((p) => p.providerId === "DAT");
    const truckstop = result.providers.find((p) => p.providerId === "TRUCKSTOP");

    lines.push("");
    lines.push("Provider status:");
    lines.push(`- DAT: ${providerStatusLabel(dat?.lifecycleStatus)}`);
    lines.push(`- Truckstop: ${providerStatusLabel(truckstop?.lifecycleStatus)}`);

    if (dat?.lifecycleStatus === "AVAILABLE" && dat.rate != null) {
        lines.push(`DAT returned: ${fmtMoney(dat.rate)}`);
    }
    if (truckstop?.lifecycleStatus === "AVAILABLE" && truckstop.rate != null) {
        lines.push(`Truckstop returned: ${fmtMoney(truckstop.rate)}`);
    }

    if (result.externalMarket?.rateRange) {
        lines.push("");
        lines.push(
            `External market range: ${fmtMoney(result.externalMarket.rateRange.low)} – ${fmtMoney(result.externalMarket.rateRange.high)}`
        );
    }

    if (result.carrierQuote != null) {
        lines.push("");
        lines.push(`Carrier quote: ${fmtMoney(result.carrierQuote)}`);
        if (result.comparison?.summary) {
            lines.push(`Comparison: ${result.comparison.summary}`);
        } else if (result.carrierQuoteAssessment) {
            lines.push(`Assessment: ${assessmentLabel(result.carrierQuoteAssessment)}`);
        }
    }

    if (result.sources.length) {
        lines.push("");
        lines.push("GreenOS sources:");
        result.sources.slice(0, 10).forEach((s) => lines.push(`- ${s.label}`));
    }

    lines.push("");
    lines.push(`Retrieved: ${result.retrievedAt}`);
    return lines.join("\n");
}

export function formatMarketRateForPanel(result: MarketRateCompositeResult): string {
    if (result.status !== "OK" && result.status !== "MISSING_MILES") {
        return result.message || result.status;
    }
    const parts: string[] = [];
    parts.push(`GreenOS Historical · ${result.sampleSize} comparables`);
    if (result.rpm) {
        parts.push(
            `RPM ${fmtRpm(result.rpm.p25)}–${fmtRpm(result.rpm.p75)} (med ${fmtRpm(result.rpm.median)})`
        );
    }
    if (result.recommendedTarget != null) {
        parts.push(`Target ${fmtMoney(result.recommendedTarget)}`);
    }

    const dat = result.providers.find((p) => p.providerId === "DAT");
    const truckstop = result.providers.find((p) => p.providerId === "TRUCKSTOP");
    parts.push(`DAT: ${providerStatusLabel(dat?.lifecycleStatus)}`);
    parts.push(`Truckstop: ${providerStatusLabel(truckstop?.lifecycleStatus)}`);

    if (result.carrierQuote != null && result.comparison?.summary) {
        parts.push(`Quote ${fmtMoney(result.carrierQuote)} · ${result.comparison.summary}`);
    }
    return parts.join("\n");
}

export function formatProviderStatusesForPanel(result: MarketRateCompositeResult): string {
    return (result.providers || [])
        .map((p) => {
            if (p.lifecycleStatus === "NOT_CONFIGURED") {
                return `${p.source}: Not connected`;
            }
            if (p.lifecycleStatus === "TIMEOUT") {
                return `${p.source}: Timeout`;
            }
            if (p.lifecycleStatus === "AVAILABLE" && p.rate != null) {
                return `${p.source}: ${fmtMoney(p.rate)}`;
            }
            return `${p.source}: ${providerStatusLabel(p.lifecycleStatus)}`;
        })
        .join("\n");
}

/** @deprecated alias — accepts composite or legacy internal shape */
export type MarketRateFormatInput = MarketRateCompositeResult;

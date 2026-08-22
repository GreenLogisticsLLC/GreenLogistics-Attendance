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

export function formatMarketRateForChat(result: MarketRateResult): string {
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
        return (
            result.message ||
            "Insufficient GreenOS historical data to calculate a reliable estimate."
        );
    }

    const lines: string[] = [];
    lines.push("Internal GreenOS historical analysis:");
    lines.push("");
    lines.push(`Comparable shipments: ${result.sampleSize}`);
    lines.push(`Comparison: ${comparisonLabel(result.comparisonLevel)}`);
    lines.push("");
    if (result.rpm) {
        lines.push("Historical RPM:");
        lines.push(`P25: ${fmtRpm(result.rpm.p25)}`);
        lines.push(`Median: ${fmtRpm(result.rpm.median)}`);
        lines.push(`P75: ${fmtRpm(result.rpm.p75)}`);
        lines.push("");
    }
    if (result.rate) {
        lines.push(`Historical rate range: ${fmtMoney(result.rate.p25)} – ${fmtMoney(result.rate.p75)}`);
        lines.push("");
    }
    if (result.recommendedTarget != null) {
        lines.push(`Internal historical target: ${fmtMoney(result.recommendedTarget)}`);
        lines.push("");
    }
    lines.push(`Confidence: ${result.confidence || "—"}`);
    if (result.recencyNote) lines.push(result.recencyNote);
    lines.push("");
    lines.push(
        "Important: This is an INTERNAL HISTORICAL estimate, not a live market quote."
    );
    if (result.carrierQuote != null) {
        lines.push("");
        lines.push(`Carrier quote: ${fmtMoney(result.carrierQuote)}`);
        if (result.carrierQuoteAssessment) {
            lines.push(`Assessment: ${assessmentLabel(result.carrierQuoteAssessment)}`);
        }
    }
    if (result.sources.length) {
        lines.push("");
        lines.push("Sources:");
        result.sources.slice(0, 10).forEach((s) => lines.push(`- ${s.label}`));
        if (result.sources.length > 10) {
            lines.push(`… and ${result.sources.length - 10} more`);
        }
    }
    return lines.join("\n");
}

export function formatMarketRateForPanel(result: MarketRateResult): string {
    if (result.status !== "OK") {
        return result.message || result.status;
    }
    const parts: string[] = [];
    parts.push(`Comparable: ${result.sampleSize} (${comparisonLabel(result.comparisonLevel)})`);
    if (result.rpm) {
        parts.push(
            `RPM P25 ${fmtRpm(result.rpm.p25)} · Med ${fmtRpm(result.rpm.median)} · P75 ${fmtRpm(result.rpm.p75)}`
        );
    }
    if (result.rate) {
        parts.push(`Rate ${fmtMoney(result.rate.p25)}–${fmtMoney(result.rate.p75)}`);
    }
    if (result.recommendedTarget != null) {
        parts.push(`Target ${fmtMoney(result.recommendedTarget)} (${result.confidence || "—"})`);
    }
    if (result.carrierQuote != null && result.carrierQuoteAssessment) {
        parts.push(`Quote ${fmtMoney(result.carrierQuote)}: ${assessmentLabel(result.carrierQuoteAssessment)}`);
    }
    return parts.join("\n");
}

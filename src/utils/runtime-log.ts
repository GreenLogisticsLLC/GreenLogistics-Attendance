/**
 * Structured runtime logging for Contabo / PM2.
 * Never log secrets, tokens, passwords, or full sensitive customer payloads.
 */

export type RuntimeLogLevel = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type RuntimeLogFields = {
    module: string;
    message: string;
    shipmentId?: string | null;
    providerId?: string | null;
    category?: string;
    retryEligible?: boolean;
    detail?: string;
};

const SECRET_RE =
    /(password|secret|token|authorization|api[_-]?key|client[_-]?secret|refresh[_-]?token|paypal_client)/i;

function sanitizeDetail(detail: string | undefined): string | undefined {
    if (!detail) return undefined;
    const trimmed = detail.replace(/\s+/g, " ").trim().slice(0, 400);
    if (SECRET_RE.test(trimmed)) return "[redacted]";
    return trimmed;
}

export function runtimeLog(level: RuntimeLogLevel, fields: RuntimeLogFields): void {
    const parts = [
        `[${level}]`,
        `[${fields.module}]`,
        fields.category ? `category=${fields.category}` : null,
        fields.shipmentId ? `shipment=${fields.shipmentId}` : null,
        fields.providerId ? `provider_id=${fields.providerId}` : null,
        fields.retryEligible == null ? null : `retry=${fields.retryEligible ? "yes" : "no"}`,
        fields.message,
        sanitizeDetail(fields.detail) ? `detail=${sanitizeDetail(fields.detail)}` : null,
    ].filter(Boolean);

    const line = parts.join(" ");
    if (level === "CRITICAL" || level === "ERROR") {
        console.error(line);
    } else if (level === "WARNING") {
        console.warn(line);
    } else {
        console.log(line);
    }
}

function errorMessageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err && typeof err === "object" && "message" in err) {
        return String((err as { message?: unknown }).message || "");
    }
    return String(err || "");
}

export function isPermanentGmailMissingError(err: unknown): boolean {
    const code = Number((err as { code?: number })?.code || 0);
    const status = Number((err as { status?: number })?.status || 0);
    const message = errorMessageOf(err);
    if (code === 404 || status === 404) return true;
    return /requested entity was not found/i.test(message);
}

export function isPermanentInvalidPdfError(err: unknown): boolean {
    const message = errorMessageOf(err);
    return /invalid pdf structure|pdf header|not a pdf|corrupted pdf|empty pdf|missing %%eof/i.test(
        message
    );
}

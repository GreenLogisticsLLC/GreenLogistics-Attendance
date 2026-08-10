/**
 * CarrierView API errors.
 * CarrierView may return HTTP 200 with success:false — always inspect body.
 */

export class CarrierViewError extends Error {
    readonly code: string;
    readonly httpStatus: number;
    /** Alias for Express-style catch blocks that read `err.status`. */
    readonly status: number;
    readonly details: unknown;

    constructor(code: string, message: string, httpStatus = 502, details?: unknown) {
        super(message);
        this.name = "CarrierViewError";
        this.code = code;
        this.httpStatus = httpStatus;
        this.status = httpStatus;
        this.details = details;
    }
}

export class CarrierViewUserNotFound extends CarrierViewError {
    constructor(details?: unknown) {
        super("user_not_found", "CarrierView user not found", 404, details);
        this.name = "CarrierViewUserNotFound";
    }
}
export class CarrierViewCompanyNotFound extends CarrierViewError {
    constructor(details?: unknown) {
        super("company_not_found", "CarrierView company not found", 404, details);
        this.name = "CarrierViewCompanyNotFound";
    }
}
export class CarrierViewCompanyDisabled extends CarrierViewError {
    constructor(details?: unknown) {
        super("company_disabled", "CarrierView company is disabled", 403, details);
        this.name = "CarrierViewCompanyDisabled";
    }
}
export class CarrierViewLoadNotFound extends CarrierViewError {
    constructor(details?: unknown) {
        super("load_not_found", "CarrierView load not found", 404, details);
        this.name = "CarrierViewLoadNotFound";
    }
}
export class CarrierViewPermissionDenied extends CarrierViewError {
    constructor(details?: unknown) {
        super("permission_denied", "CarrierView permission denied", 403, details);
        this.name = "CarrierViewPermissionDenied";
    }
}
export class CarrierViewValidationError extends CarrierViewError {
    constructor(details?: unknown) {
        super("required_fields_errors", "CarrierView validation failed", 422, details);
        this.name = "CarrierViewValidationError";
    }
}
export class CarrierViewCreationError extends CarrierViewError {
    constructor(details?: unknown) {
        super("creation_error", "CarrierView failed to create load", 502, details);
        this.name = "CarrierViewCreationError";
    }
}
export class CarrierViewDriverOptedOut extends CarrierViewError {
    constructor(details?: unknown) {
        super("driver_opted_out", "Driver opted out of CarrierView SMS", 422, details);
        this.name = "CarrierViewDriverOptedOut";
    }
}
export class CarrierViewSmsProviderFailed extends CarrierViewError {
    constructor(details?: unknown) {
        super("sms_provider_failed", "CarrierView SMS provider failed", 502, details);
        this.name = "CarrierViewSmsProviderFailed";
    }
}
export class CarrierViewRateLimited extends CarrierViewError {
    constructor(details?: unknown) {
        super("rate_limited", "CarrierView rate limit exceeded (SMS: 5/min)", 429, details);
        this.name = "CarrierViewRateLimited";
    }
}
export class CarrierViewInternalError extends CarrierViewError {
    constructor(details?: unknown) {
        super("internal_error", "CarrierView internal error", 502, details);
        this.name = "CarrierViewInternalError";
    }
}
export class CarrierViewNotConfigured extends CarrierViewError {
    constructor() {
        super(
            "not_configured",
            "CarrierView is not configured (set CARRIER_VIEW_API_BASE_URL and CARRIER_VIEW_API_TOKEN)",
            503
        );
        this.name = "CarrierViewNotConfigured";
    }
}

export function mapCarrierViewError(errorCode: string | undefined, errors?: unknown, httpStatus = 200) {
    const code = String(errorCode || "internal_error").toLowerCase();
    switch (code) {
        case "user_not_found":
            return new CarrierViewUserNotFound(errors);
        case "company_not_found":
            return new CarrierViewCompanyNotFound(errors);
        case "company_disabled":
            return new CarrierViewCompanyDisabled(errors);
        case "load_not_found":
            return new CarrierViewLoadNotFound(errors);
        case "permission_denied":
            return new CarrierViewPermissionDenied(errors);
        case "required_fields_errors":
            return new CarrierViewValidationError(errors);
        case "creation_error":
            return new CarrierViewCreationError(errors);
        case "driver_opted_out":
            return new CarrierViewDriverOptedOut(errors);
        case "sms_provider_failed":
            return new CarrierViewSmsProviderFailed(errors);
        case "internal_error":
            return new CarrierViewInternalError(errors);
        default:
            if (httpStatus === 429) return new CarrierViewRateLimited(errors);
            return new CarrierViewError(code, `CarrierView error: ${code}`, httpStatus || 502, errors);
    }
}

/** Safe message for brokers/UI — include validation field hints when present. */
export function carrierViewUserMessage(err: unknown): string {
    if (err instanceof CarrierViewError) {
        const hint = formatDetailsHint(err.details);
        return hint ? `${err.message}: ${hint}` : err.message;
    }
    if (err instanceof Error) return err.message;
    return "CarrierView request failed";
}

function formatDetailsHint(details: unknown): string {
    if (details == null) return "";
    if (typeof details === "string") return details.slice(0, 240);
    if (Array.isArray(details)) {
        return details
            .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
            .filter(Boolean)
            .slice(0, 6)
            .join("; ")
            .slice(0, 240);
    }
    if (typeof details === "object") {
        const parts: string[] = [];
        for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
            if (v == null) continue;
            const val =
                typeof v === "string"
                    ? v
                    : Array.isArray(v)
                      ? v.map(String).join(", ")
                      : typeof v === "object"
                        ? JSON.stringify(v)
                        : String(v);
            parts.push(`${k}: ${val}`);
            if (parts.length >= 6) break;
        }
        return parts.join("; ").slice(0, 240);
    }
    return "";
}

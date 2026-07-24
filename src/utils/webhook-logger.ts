import type { IncomingHttpHeaders } from "http";

const SENSITIVE_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
]);

export function sanitizeWebhookHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            out[key] = "[REDACTED]";
            continue;
        }
        if (Array.isArray(value)) out[key] = value.join(", ");
        else if (value !== undefined) out[key] = String(value);
    }
    return out;
}

export function formatPresenceStatus(status: string | null | undefined): string {
    switch (status) {
        case "INSIDE_OFFICE":
            return "In Office";
        case "OUTSIDE_OFFICE":
            return "Out of Office";
        case "COMPLETED":
            return "Completed / Left";
        case "SCHEDULED":
            return "Scheduled";
        case "EXCEPTION":
            return "Exception";
        default:
            return status || "Unknown";
    }
}

export function logWebhookReceived(input: {
    path: string;
    headers: IncomingHttpHeaders;
    body: unknown;
}) {
    const safeHeaders = sanitizeWebhookHeaders(input.headers);
    console.log("[WEBHOOK RECEIVED]");
    console.log(`path: ${input.path}`);
    console.log("headers:", JSON.stringify(safeHeaders, null, 2));
    console.log("body:", JSON.stringify(input.body ?? {}, null, 2));
}

export function logWebhookDecision(input: {
    deviceId?: string;
    token?: string;
    decision?: string;
    directionHint?: string;
    scannedAt?: string;
    employeeName?: string | null;
    action?: "IN" | "OUT" | "UNKNOWN" | "DUPLICATE" | "NOT_FOUND";
    status?: string | null;
    note?: string;
}) {
    const lines = [
        "[WEBHOOK RECEIVED]",
        `device_id: ${input.deviceId ?? "—"}`,
        `token: ${input.token ?? "—"}`,
        `decision: ${input.decision ?? "—"}`,
        `direction: ${input.directionHint ?? "—"}`,
        `scanned_at: ${input.scannedAt ?? "—"}`,
        "",
        `Employee: ${input.employeeName || "NOT FOUND"}`,
        `Action: ${input.action ?? "UNKNOWN"}`,
        `Status: ${formatPresenceStatus(input.status)}`,
    ];
    if (input.note) lines.push(`Note: ${input.note}`);
    console.log(lines.join("\n"));
}

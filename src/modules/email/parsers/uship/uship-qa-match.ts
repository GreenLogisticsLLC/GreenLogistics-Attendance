/** Helpers for matching uShip Q&A emails (Question Answered / Customer Respond). */

export function normalizeUshipTitle(value: string): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Titles hinted by uShip Q&A subjects and "SHIPMENT NAME" blocks. */
export function titlesFromQuestionAnsweredEmail(subject: string, body: string): string[] {
    const out: string[] = [];
    const push = (raw: string) => {
        const t = normalizeUshipTitle(raw);
        if (t.length >= 4 && !out.includes(t)) out.push(t);
    };
    const sub = String(subject || "");
    const subMatch = sub.match(
        /^(?:question\s+answered|customer\s+(?:respond(?:ed)?|replied|reply)|new\s+(?:message|reply)|code\s+answered)\s*[-:–—]\s*(.+)$/i
    );
    if (subMatch?.[1]) push(subMatch[1]);
    const nameMatch = String(body || "").match(
        /shipment\s*name\s*[:#]?\s*([^\n\r|<]{3,80})/i
    );
    if (nameMatch?.[1]) push(nameMatch[1]);
    return out;
}

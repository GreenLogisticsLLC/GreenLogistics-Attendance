/** Pull a uShip listing id/URL out of email HTML, tracking links, and card fields. */

export function normalizeListingBlob(raw: string): string {
    let text = String(raw || "");
    text = text.replace(/=\r?\n/g, "");
    text = text.replace(/=3D/gi, "=");
    text = text.replace(/&amp;/gi, "&");
    text = text.replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%3F/gi, "?").replace(/%3D/gi, "=");
    return text;
}

export function listingIdsFromText(...blobs: Array<string | null | undefined>): string[] {
    const ids = new Set<string>();
    const text = blobs.map((blob) => normalizeListingBlob(String(blob || ""))).join("\n");
    if (!text) return [];
    const patterns = [
        /uship\.com\/(?:listing|shipment|l)\/(\d{5,})/gi,
        /\/listing\/(\d{5,})(?:\/|[?#"'<\s>]|$)/gi,
        /listing[_/-](?:id|number|#)?[_/-]?(\d{5,})/gi,
        /(?:listing|shipment)(?:id|_id)?\s*[=:#]?\s*(\d{5,})/gi,
        /(?:listing|shipment)\s*(?:id|#|number)?\s*[:#]?\s*(\d{5,})/gi,
    ];
    for (const re of patterns) {
        for (const match of text.matchAll(re)) {
            if (match[1]) ids.add(match[1]);
        }
    }
    return [...ids];
}

export function listingIdFromText(...blobs: Array<string | null | undefined>): string | null {
    return listingIdsFromText(...blobs)[0] || null;
}

export function canonicalUshipListingUrl(listingId: string): string {
    return `https://www.uship.com/listing/${listingId}`;
}

export function ushipListingUrlFromLead(
    lead: Record<string, unknown>,
    extraBlobs: Array<string | null | undefined> = []
): string | null {
    const view = String(lead.viewUrl || "").trim();
    const fromView = listingIdFromText(view);
    if (fromView) return canonicalUshipListingUrl(fromView);
    if (view.startsWith("http") && /uship\.com/i.test(view)) return view;
    const ext = String(lead.externalShipmentId || "").trim();
    if (/^\d{5,}$/.test(ext)) return canonicalUshipListingUrl(ext);
    const found = listingIdFromText(
        view,
        ext,
        String(lead.imageUrl || ""),
        String(lead.shipmentTitle || ""),
        String(lead.notes || ""),
        ...extraBlobs
    );
    return found ? canonicalUshipListingUrl(found) : null;
}

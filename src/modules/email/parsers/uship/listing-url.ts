/** Pull a uShip listing id/URL out of email HTML, tracking links, and card fields. */

const MIN_URL_ID_LEN = 6;
const MIN_LOOSE_ID_LEN = 8;

export function normalizeListingBlob(raw: string): string {
    let text = String(raw || "");
    text = text.replace(/=\r?\n/g, "");
    text = text.replace(/=3D/gi, "=");
    text = text.replace(/=2F/gi, "/");
    text = text.replace(/=3A/gi, ":");
    text = text.replace(/&amp;/gi, "&");
    text = text.replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%3F/gi, "?").replace(/%3D/gi, "=");
    return text;
}

export function listingSlugFromTitle(raw: string): string {
    return String(raw || "")
        .replace(/[''`]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);
}

export function isUshipTrackingOrJunkUrl(url: string): boolean {
    return /click\.mail\.uship|mail\.uship\.com\/ls\/click|find-shipments|\/find\/?$/i.test(url);
}

export function canonicalUshipListingUrl(listingId: string, slugOrTitle?: string): string {
    const id = String(listingId || "").replace(/\D/g, "");
    const slug = listingSlugFromTitle(slugOrTitle || "");
    if (slug) return `https://www.uship.com/listing/${id}/${slug}/`;
    return `https://www.uship.com/listing/${id}/`;
}

export type ListingRef = { id: string; slug: string };

function isPlausibleListingId(id: string, minLen: number): boolean {
    return /^\d+$/.test(id) && id.length >= minLen && id.length <= 12;
}

function expandEncodedUrls(text: string): string {
    const expanded: string[] = [];
    for (const match of text.matchAll(/[?&](?:url|u|redirect|dest|destination|target|href)=([^&\s"'<>]+)/gi)) {
        try {
            expanded.push(decodeURIComponent(match[1]));
        } catch {
            expanded.push(match[1]);
        }
    }
    for (const match of text.matchAll(/href=["']([^"'>]+uship[^"'>]*)["']/gi)) {
        try {
            expanded.push(decodeURIComponent(match[1]));
        } catch {
            expanded.push(match[1]);
        }
    }
    return expanded.length ? `${text}\n${expanded.join("\n")}` : text;
}

export function listingRefsFromText(...blobs: Array<string | null | undefined>): ListingRef[] {
    const seen = new Set<string>();
    const refs: ListingRef[] = [];
    let text = blobs.map((blob) => normalizeListingBlob(String(blob || ""))).join("\n");
    if (!text) return [];
    text = expandEncodedUrls(text);

    const push = (id: string, slug = "", minLen = MIN_URL_ID_LEN) => {
        if (!isPlausibleListingId(id, minLen) || seen.has(id)) return;
        seen.add(id);
        refs.push({ id, slug: listingSlugFromTitle(slug) });
    };

    const urlRe = /uship\.com\/(?:listing|shipment|l)\/(\d{6,12})(?:\/([^\/?#\s"']*))?/gi;
    for (const match of text.matchAll(urlRe)) {
        push(match[1], match[2] || "");
    }
    for (const match of text.matchAll(/\/listing\/(\d{6,12})(?:\/([^\/?#\s"']*))?/gi)) {
        push(match[1], match[2] || "");
    }
    for (const match of text.matchAll(/[?&](?:listingId|listing_id|shipmentId|shipment_id)=(\d{6,12})/gi)) {
        push(match[1]);
    }
    for (const match of text.matchAll(/(?:listing|shipment)\s*(?:id|#|number)\s*[:#=]?\s*(\d{8,12})/gi)) {
        push(match[1], "", MIN_LOOSE_ID_LEN);
    }
    return refs;
}

export function listingIdsFromText(...blobs: Array<string | null | undefined>): string[] {
    return listingRefsFromText(...blobs).map((ref) => ref.id);
}

export function listingIdFromText(...blobs: Array<string | null | undefined>): string | null {
    return listingRefsFromText(...blobs)[0]?.id || null;
}

export function ushipListingUrlFromLead(
    lead: Record<string, unknown>,
    extraBlobs: Array<string | null | undefined> = []
): string | null {
    const title = String(lead.shipmentTitle || "");
    const view = String(lead.viewUrl || "").trim();
    const ext = String(lead.externalShipmentId || "").trim();
    const blobs = [view, ext, String(lead.imageUrl || ""), title, String(lead.notes || ""), ...extraBlobs];
    const refs = listingRefsFromText(...blobs);
    const fromUrl = refs[0];
    const slug = fromUrl?.slug || listingSlugFromTitle(title);

    if (fromUrl) return canonicalUshipListingUrl(fromUrl.id, slug);

    if (/^\d{6,12}$/.test(ext) && !isUshipTrackingOrJunkUrl(view)) {
        return canonicalUshipListingUrl(ext, slug);
    }

    if (view.startsWith("http") && /uship\.com/i.test(view) && !isUshipTrackingOrJunkUrl(view)) {
        const fromView = listingRefsFromText(view)[0];
        if (fromView) return canonicalUshipListingUrl(fromView.id, fromView.slug || slug);
    }
    return null;
}

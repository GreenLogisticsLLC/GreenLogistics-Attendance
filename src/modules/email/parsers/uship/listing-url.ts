/** Pull a uShip listing id/URL out of email HTML, tracking links, and card fields. */

const MIN_URL_ID_LEN = 6;
const MIN_LOOSE_ID_LEN = 8;

function decodeFully(raw: string): string {
    let prev = String(raw || "");
    for (let i = 0; i < 3; i++) {
        try {
            const next = decodeURIComponent(prev.replace(/\+/g, " "));
            if (next === prev) break;
            prev = next;
        } catch {
            break;
        }
    }
    return prev;
}

export function normalizeListingBlob(raw: string): string {
    let text = String(raw || "");
    text = text.replace(/=\r?\n/g, "");
    text = text.replace(/=3D/gi, "=");
    text = text.replace(/=2F/gi, "/");
    text = text.replace(/=3A/gi, ":");
    text = text.replace(/&amp;/gi, "&");
    text = decodeFully(text);
    return text;
}

export function listingSlugFromTitle(raw: string): string {
    return String(raw || "")
        .replace(/[''`]/g, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
}

export function isUshipTrackingOrJunkUrl(url: string): boolean {
    return /track\.uship\.com|click\.mail\.uship|mail\.uship\.com\/ls\/click|find-shipments|signin\.aspx/i.test(
        url
    );
}

/** Instant Alerts use /shipment/{slug}/{id}/ ; older emails use /listing/{id}/{slug}/ */
export function hasRealListingSlug(url: string | null | undefined): boolean {
    const u = String(url || "");
    return (
        /uship\.com\/(?:listing|l)\/\d{6,12}\/[A-Za-z0-9][^\/?#]*/i.test(u) ||
        /uship\.com\/shipment\/[^\/?#]+\/\d{6,12}/i.test(u)
    );
}

export function canonicalUshipListingUrl(listingId: string, slugFromUrl?: string): string {
    const id = String(listingId || "").replace(/\D/g, "");
    const slug = listingSlugFromTitle(slugFromUrl || "");
    if (slug) return `https://www.uship.com/listing/${id}/${slug}/`;
    return `https://www.uship.com/listing/${id}/`;
}

/** Current Instant Alert destination format from track.uship.com redirects. */
export function canonicalUshipShipmentUrl(listingId: string, slugOrTitle?: string): string {
    const id = String(listingId || "").replace(/\D/g, "");
    const slug = listingSlugFromTitle(slugOrTitle || "") || "shipment";
    return `https://www.uship.com/shipment/${slug}/${id}/`;
}

export function cleanResolvedUshipUrl(raw: string): string | null {
    const text = String(raw || "");
    const shipment = text.match(
        /https?:\/\/(?:www\.)?uship\.com\/shipment\/[^\/?#\s"']+\/\d{6,12}/i
    );
    if (shipment) {
        const url = shipment[0].replace(/^http:\/\//i, "https://");
        return url.endsWith("/") ? url : `${url}/`;
    }
    const listing = text.match(
        /https?:\/\/(?:www\.)?uship\.com\/(?:listing|l)\/\d{6,12}\/[^\/?#\s"']+/i
    );
    if (listing) {
        const url = listing[0]
            .replace(/^http:\/\//i, "https://")
            .replace(/uship\.com\/l\//i, "uship.com/listing/");
        return url.endsWith("/") ? url : `${url}/`;
    }
    return null;
}

export type ListingRef = { id: string; slug: string };

function isPlausibleListingId(id: string, minLen: number): boolean {
    return /^\d+$/.test(id) && id.length >= minLen && id.length <= 12;
}

function expandEncodedUrls(text: string): string {
    const expanded: string[] = [text];
    for (const match of text.matchAll(/[?&](?:url|u|redirect|dest|destination|target|href)=([^&\s"'<>]+)/gi)) {
        expanded.push(decodeFully(match[1]));
    }
    for (const match of text.matchAll(/href=["']([^"'>]+uship[^"'>]*)["']/gi)) {
        expanded.push(decodeFully(match[1]));
    }
    return expanded.join("\n");
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

    // Instant Alert format: /shipment/{slug}/{id}/
    for (const match of text.matchAll(/uship\.com\/shipment\/([^\/?#\s"']+)\/(\d{6,12})/gi)) {
        push(match[2], match[1]);
    }
    // Classic format: /listing/{id}/{slug}/
    for (const match of text.matchAll(/uship\.com\/(?:listing|l)\/(\d{6,12})(?:\/([^\/?#\s"']*))?/gi)) {
        push(match[1], match[2] || "");
    }
    for (const match of text.matchAll(/\/listing\/(\d{6,12})(?:\/([^\/?#\s"']*))?/gi)) {
        push(match[1], match[2] || "");
    }
    for (const match of text.matchAll(/#\/listings?\/(\d{6,12})/gi)) {
        push(match[1]);
    }
    for (const match of text.matchAll(/listing2\.aspx\?[^"'<\s]*\b(?:listing)?id=(\d{6,12})/gi)) {
        push(match[1]);
    }
    for (const match of text.matchAll(/[?&](?:listingId|listing_id|shipmentId|shipment_id)=(\d{6,12})/gi)) {
        push(match[1]);
    }
    for (const match of text.matchAll(/ID\s*#\s*(\d{8,12})/gi)) {
        push(match[1], "", MIN_LOOSE_ID_LEN);
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

export function isUshipListingId(value: string | null | undefined): boolean {
    return isPlausibleListingId(String(value || "").trim(), MIN_URL_ID_LEN);
}

/** Prefer Instant Alert /shipment/{slug}/{id}/, else classic /listing/{id}/{slug}/. */
export function originalListingUrlForId(
    listingId: string,
    ...blobs: Array<string | null | undefined>
): string | null {
    const id = String(listingId || "").replace(/\D/g, "");
    if (!isUshipListingId(id)) return null;
    let text = blobs.map((blob) => normalizeListingBlob(String(blob || ""))).join("\n");
    text = expandEncodedUrls(text);

    const shipmentRe = new RegExp(
        String.raw`https?:\/\/(?:www\.)?uship\.com\/shipment\/([^\/?#\s"']+)\/${id}`,
        "i"
    );
    const shipment = text.match(shipmentRe);
    if (shipment) {
        const url = shipment[0].replace(/^http:\/\//i, "https://");
        return url.endsWith("/") ? url : `${url}/`;
    }

    const listingRe = new RegExp(
        String.raw`https?:\/\/(?:www\.)?uship\.com\/(?:listing|l)\/${id}\/([^\/?#\s"']+)`,
        "i"
    );
    const listing = text.match(listingRe);
    if (listing) {
        const url = listing[0]
            .replace(/^http:\/\//i, "https://")
            .replace(/uship\.com\/l\//i, "uship.com/listing/");
        return url.endsWith("/") ? url : `${url}/`;
    }
    return null;
}

export function trackingUrlsFromText(...blobs: Array<string | null | undefined>): string[] {
    const text = blobs.map((blob) => normalizeListingBlob(String(blob || ""))).join("\n");
    const urls = new Set<string>();
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>]*uship\.com\/[^\s"'<>]+/gi)) {
        const url = match[0].replace(/[)>.,;]+$/g, "");
        if (/track\.uship\.com|click\.mail\.uship|\/ls\/click|upn=/i.test(url)) urls.add(url);
    }
    return [...urls].sort((a, b) => {
        const rank = (u: string) => (/\/f\/a\//i.test(u) ? 0 : /track\.uship\.com\/q\//i.test(u) ? 2 : 1);
        return rank(a) - rank(b);
    });
}

const USHIP_HOST = /(^|\.)uship\.com$/i;

function sluggedListingUrlFrom(...blobs: Array<string | null | undefined>): string | null {
    for (const blob of blobs) {
        const cleaned = cleanResolvedUshipUrl(String(blob || ""));
        if (cleaned) return cleaned;
    }
    const refs = listingRefsFromText(...blobs);
    const withSlug = refs.find((ref) => ref.slug);
    if (!withSlug) return null;
    return (
        originalListingUrlForId(withSlug.id, ...blobs) ||
        canonicalUshipShipmentUrl(withSlug.id, withSlug.slug)
    );
}

/** Follow track.uship.com / click wrappers to the real shipment or listing page. */
export async function followUshipToListingUrl(startUrl: string): Promise<string | null> {
    let url = String(startUrl || "").trim();
    if (!url) return null;
    for (let hop = 0; hop < 8; hop++) {
        const cleaned = cleanResolvedUshipUrl(url);
        if (cleaned) return cleaned;
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        if (!USHIP_HOST.test(parsed.hostname)) return null;
        try {
            const res = await fetch(url, {
                method: "GET",
                redirect: "manual",
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    Accept: "text/html,application/xhtml+xml",
                },
                signal: AbortSignal.timeout(8000),
            });
            const loc = res.headers.get("location");
            if (loc) {
                url = new URL(loc, url).toString();
                continue;
            }
            if (res.status >= 200 && res.status < 300) {
                const body = await res.text().catch(() => "");
                return sluggedListingUrlFrom(body, url);
            }
            return null;
        } catch {
            return null;
        }
    }
    return cleanResolvedUshipUrl(url) || sluggedListingUrlFrom(url);
}

export function ushipListingUrlFromLead(
    lead: Record<string, unknown>,
    extraBlobs: Array<string | null | undefined> = []
): string | null {
    const view = String(lead.viewUrl || "").trim();
    const ext = String(lead.externalShipmentId || "").trim();
    const blobs = [view, ext, String(lead.imageUrl || ""), String(lead.notes || ""), ...extraBlobs];

    const stickyId = isUshipListingId(ext)
        ? ext
        : listingRefsFromText(view).find((ref) => ref.id)?.id || "";

    if (stickyId) {
        const original = originalListingUrlForId(stickyId, ...blobs);
        if (original && hasRealListingSlug(original)) return original;
        return null;
    }

    if (hasRealListingSlug(view) && !isUshipTrackingOrJunkUrl(view)) {
        return cleanResolvedUshipUrl(view) || view;
    }

    return sluggedListingUrlFrom(...blobs);
}

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
    return /click\.mail\.uship|mail\.uship\.com\/ls\/click|find-shipments|signin\.aspx/i.test(url);
}

export function hasRealListingSlug(url: string | null | undefined): boolean {
    return /uship\.com\/(?:listing|shipment|l)\/\d{6,12}\/[A-Za-z0-9][^\/?#]*/i.test(String(url || ""));
}

export function canonicalUshipListingUrl(listingId: string, slugFromUrl?: string): string {
    const id = String(listingId || "").replace(/\D/g, "");
    const slug = listingSlugFromTitle(slugFromUrl || "");
    if (slug) return `https://www.uship.com/listing/${id}/${slug}/`;
    return `https://www.uship.com/listing/${id}/`;
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

    const urlRe = /uship\.com\/(?:listing|shipment|l)\/(\d{6,12})(?:\/([^\/?#\s"']*))?/gi;
    for (const match of text.matchAll(urlRe)) {
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
    for (const match of text.matchAll(/[?&](?:listingId|listing_id|shipmentId|shipment_id|id)=(\d{6,12})/gi)) {
        // Avoid zip-like false positives on bare id= only when other listing context exists nearby
        if (/listing|shipment|uship/i.test(text.slice(Math.max(0, match.index - 40), match.index + 40))) {
            push(match[1]);
        }
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

/** Original listing URL including uShip's own slug. ID-only paths 404. */
export function originalListingUrlForId(
    listingId: string,
    ...blobs: Array<string | null | undefined>
): string | null {
    const id = String(listingId || "").replace(/\D/g, "");
    if (!isUshipListingId(id)) return null;
    let text = blobs.map((blob) => normalizeListingBlob(String(blob || ""))).join("\n");
    text = expandEncodedUrls(text);
    const re = new RegExp(
        String.raw`https?:\/\/(?:www\.)?uship\.com\/(?:listing|shipment|l)\/${id}\/([^\/?#\s"']+)`,
        "i"
    );
    const match = text.match(re);
    if (!match) return null;
    const cleaned = match[0]
        .replace(/^http:\/\//i, "https://")
        .replace(/uship\.com\/(?:shipment|l)\//i, "uship.com/listing/");
    return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

export function trackingUrlsFromText(...blobs: Array<string | null | undefined>): string[] {
    const text = blobs.map((blob) => normalizeListingBlob(String(blob || ""))).join("\n");
    const urls = new Set<string>();
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>]*uship\.com\/[^\s"'<>]+/gi)) {
        const url = match[0].replace(/[)>.,;]+$/g, "");
        if (/click\.mail\.uship|\/ls\/click|upn=/i.test(url)) urls.add(url);
    }
    return [...urls];
}

const USHIP_HOST = /(^|\.)uship\.com$/i;

function sluggedListingUrlFrom(...blobs: Array<string | null | undefined>): string | null {
    const refs = listingRefsFromText(...blobs);
    const withSlug = refs.find((ref) => ref.slug);
    if (!withSlug) return null;
    return originalListingUrlForId(withSlug.id, ...blobs) || canonicalUshipListingUrl(withSlug.id, withSlug.slug);
}

/** Follow click.mail.uship.com wrappers to the real /listing/{id}/{slug}/ page. */
export async function followUshipToListingUrl(startUrl: string): Promise<string | null> {
    let url = String(startUrl || "").trim();
    if (!url) return null;
    for (let hop = 0; hop < 8; hop++) {
        const slugged = sluggedListingUrlFrom(url);
        if (slugged) return slugged;
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        if (!USHIP_HOST.test(parsed.hostname)) return null;
        if (!isUshipTrackingOrJunkUrl(url) && /\/listing\/\d{6,12}\//i.test(url)) {
            return sluggedListingUrlFrom(url);
        }
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
    return sluggedListingUrlFrom(url);
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
        const id = listingIdFromText(view);
        return id ? originalListingUrlForId(id, view) || view : view;
    }

    return sluggedListingUrlFrom(...blobs);
}

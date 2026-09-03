import type { EmailParser, ParsedShipmentDraft, RawEmailMessage } from "../../models/types.js";
import { canonicalUshipListingUrl, listingIdFromText } from "./listing-url.js";

const USHIP_FROM = /uship\.com/i;
const CITY_STATE_ZIP =
    /([A-Za-z][A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/g;
const DATE_RANGE =
    /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[–—\-]+\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/g;

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&ndash;/gi, "–")
        .replace(/&mdash;/gi, "—")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/gi, " ")
        .replace(/&ndash;/gi, "–")
        .replace(/&mdash;/gi, "—");
}

function matchFirst(text: string, patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
        const m = text.match(pattern);
        if (m?.[1]) return decodeEntities(m[1].trim());
    }
    return undefined;
}

function parseUsDate(raw?: string): Date | null {
    if (!raw) return null;
    const cleaned = raw.trim();
    const m = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) {
        const d = new Date(cleaned);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, month - 1, day));
}

function parseCityStateZip(line?: string): { city?: string; state?: string; zip?: string } {
    if (!line) return {};
    const m = line.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
    if (m) {
        return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] };
    }
    const m2 = line.match(/^(.+?),\s*([A-Z]{2})$/i);
    if (m2) return { city: m2[1].trim(), state: m2[2].toUpperCase() };
    return { city: line.trim() };
}

function extractAllCityStateZips(text: string): Array<{ city: string; state: string; zip: string }> {
    const out: Array<{ city: string; state: string; zip: string }> = [];
    const re = new RegExp(CITY_STATE_ZIP.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const city = m[1].trim().replace(/\s+/g, " ");
        // Skip noise like "Alert, MN" false positives from long labels
        if (city.length < 2 || city.length > 48) continue;
        if (/^(pickup|delivery|from|to|origin|destination|saved search)$/i.test(city)) continue;
        out.push({ city, state: m[2].toUpperCase(), zip: m[3] });
    }
    return out;
}

function extractTitleFromSubject(subject: string): string {
    let t = subject.trim();
    t = t.replace(/^instant\s+alert\s*[-:|]?\s*/i, "");
    t = t.replace(/^new\s+shipment\s*-\s*/i, "");
    t = t.replace(/\s*-\s*matches\s+your.*$/i, "");
    t = t.replace(/\s*\|\s*saved\s+search.*$/i, "");
    t = t.replace(/^matches\s+your.*$/i, "");
    return t.trim();
}

function cleanCargoLabel(raw?: string): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw
        .replace(/\s+/g, " ")
        .replace(/\b(view|open listing|instant alert|saved search)\b.*/i, "")
        .trim();
    return cleaned.length >= 2 ? cleaned.slice(0, 160) : undefined;
}

/**
 * Isolated uShip parser. Future sources (DAT, Truckstop, …) get their own parsers.
 * Handles both classic "New shipment - …" and Instant Alert / Saved Search layouts.
 */
export class UShipParser implements EmailParser {
    readonly source = "USHIP" as const;

    canParse(email: RawEmailMessage): boolean {
        const from = email.fromAddress.toLowerCase();
        if (!USHIP_FROM.test(from)) return false;

        const subject = email.subject.trim().toLowerCase();
        const blob = `${subject}\n${email.snippet || ""}\n${email.bodyText || ""}`.toLowerCase();

        if (subject.startsWith("new shipment")) return true;
        if (/instant\s+alert/.test(blob)) return true;
        if (/saved\s+search/.test(blob) && /uship\.com\/(?:listing|shipment)/i.test(blob + (email.bodyHtml || ""))) {
            return true;
        }
        // Fallback: uShip listing alert with a view URL
        if (
            /(?:new\s+listing|listing\s+alert|matches\s+your|new\s+load|shipment\s+alert)/.test(blob) &&
            /uship\.com/i.test(email.bodyHtml || email.bodyText || "")
        ) {
            return true;
        }
        const htmlAndText = `${blob}\n${email.bodyHtml || ""}`;
        const hasListing = /uship\.com\/(?:listing|shipment)\/\d{5,}/i.test(htmlAndText);
        const followUp =
            /quote\s+confirmation|bid\s+submitted|bid\s+confirmation|customer\s+(?:accepted|respond|replied|question)|accepted\s+your|load\s*(?:number|#)|deleted\s+(?:this\s+)?(?:listing|shipment)|booked\s+by\s+another|your\s+code\s+has\s+been/.test(
                subject
            );
        if (hasListing && !followUp) return true;
        return false;
    }

    parse(email: RawEmailMessage): ParsedShipmentDraft | null {
        if (!this.canParse(email)) return null;

        const text = decodeEntities(
            [email.bodyText || "", email.bodyHtml ? stripHtml(email.bodyHtml) : "", email.snippet || ""].join(
                "\n"
            )
        );
        const html = email.bodyHtml || "";

        const viewUrlRaw =
            matchFirst(html, [
                /href=["'](https?:\/\/[^"']*uship\.com\/(?:listing|shipment|l)\/\d{5,}[^"']*)["']/i,
                /href=3D["'](https?:\/\/[^"']*uship\.com\/(?:listing|shipment|l)\/\d{5,}[^"']*)["']/i,
                /(https?:\/\/(?:www\.)?uship\.com\/(?:listing|shipment|l)\/\d{5,}[^\s"'<>]*)/i,
            ]) ||
            matchFirst(text, [
                /(https?:\/\/(?:www\.)?uship\.com\/(?:listing|shipment|l)\/\d{5,}[^\s"'<>]*)/i,
            ]);

        const externalShipmentId =
            listingIdFromText(viewUrlRaw, html, text) ||
            matchFirst(text, [/Shipment\s*#?\s*:?\s*(\d{5,})/i, /Listing\s*#?\s*:?\s*(\d{5,})/i]);
        const viewUrl = viewUrlRaw || (externalShipmentId ? canonicalUshipListingUrl(externalShipmentId) : undefined);

        // --- Locations: labeled first, then Instant Alert unlabeled pairs ---
        const pickupLine = matchFirst(text, [
            /Pickup[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
            /From[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
            /Origin[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
        ]);
        const deliveryLine = matchFirst(text, [
            /Delivery[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
            /To[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
            /Destination[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
        ]);

        let pickup = parseCityStateZip(pickupLine);
        let delivery = parseCityStateZip(deliveryLine);

        if (!pickup.city || !delivery.city) {
            const places = extractAllCityStateZips(text);
            if (!pickup.city && places[0]) {
                pickup = places[0];
            }
            if (!delivery.city && places.length >= 2) {
                delivery = places[1];
            } else if (!delivery.city && places.length === 1 && pickup.city) {
                // only one found and already used as pickup — leave delivery empty
            }
        }

        // --- Date windows ---
        let pickupFromRaw = matchFirst(text, [
            /Pickup(?:\s+date)?(?:\s+from)?[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
            /Ready[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);
        let pickupToRaw = matchFirst(text, [
            /Pickup(?:\s+date)?(?:\s+to|[-–—])\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);
        let deliveryFromRaw = matchFirst(text, [
            /Delivery(?:\s+date)?(?:\s+from)?[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
            /Deliver by[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);
        let deliveryToRaw = matchFirst(text, [
            /Delivery(?:\s+date)?(?:\s+to|[-–—])\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);

        const rawRanges = [...text.matchAll(new RegExp(DATE_RANGE.source, "g"))];
        if (rawRanges[0]) {
            pickupFromRaw = pickupFromRaw || rawRanges[0][1];
            pickupToRaw = pickupToRaw || rawRanges[0][2];
        }
        if (rawRanges[1]) {
            deliveryFromRaw = deliveryFromRaw || rawRanges[1][1];
            deliveryToRaw = deliveryToRaw || rawRanges[1][2];
        }

        // --- Miles ---
        const milesRaw = matchFirst(text, [
            /(?:Distance|Miles)[:\s]+([\d,.]+)\s*(?:mi|miles)?/i,
            /([\d,.]+)\s*mi(?:les)?\b/i,
        ]);
        const miles = milesRaw ? Number(milesRaw.replace(/,/g, "")) : null;

        // --- Cargo / vehicle / category (Instant Alert: "2 Pallets" + "LTL Freight: New Commercial Goods") ---
        const palletOrQty = matchFirst(text, [
            /(\d+\s+(?:Pallets?|Pieces?|Items?|Units?|Vehicles?|Cars?|Motorcycles?|Boats?))/i,
            /(?:Quantity|Qty)[:\s]+([A-Za-z0-9 /+-]+)/i,
        ]);
        const freightLine = matchFirst(text, [
            /((?:LTL|FTL|FCL|Partial)\s+Freight\s*:\s*[A-Za-z0-9 /&+',.-]+)/i,
            /(Freight\s*:\s*[A-Za-z0-9 /&+',.-]+)/i,
        ]);
        const category =
            cleanCargoLabel(
                matchFirst(text, [
                    /Category[:\s]+([A-Za-z0-9 /&+-]+)/i,
                    /Vehicle type[:\s]+([A-Za-z0-9 /&+-]+)/i,
                    /(?:LTL|FTL)\s+Freight\s*:\s*([A-Za-z0-9 /&+',.-]+)/i,
                ])
            ) || cleanCargoLabel(freightLine);

        const vehicleParts = [palletOrQty, freightLine || category].filter(Boolean) as string[];
        const vehicle = cleanCargoLabel(
            matchFirst(text, [
                /Vehicle[:\s]+([A-Za-z0-9 /&+',.-]{3,80})/i,
                /Item(?:s)?[:\s]+([A-Za-z0-9 /&+',.-]{3,80})/i,
                /Commodity[:\s]+([A-Za-z0-9 /&+',.-]{3,80})/i,
            ]) || (vehicleParts.length ? vehicleParts.join(" · ") : undefined)
        );

        const equipment = cleanCargoLabel(
            matchFirst(text, [
                /Equipment[:\s]+([A-Za-z0-9 /&+-]+)/i,
                /Trailer[:\s]+([A-Za-z0-9 /&+-]+)/i,
                /\b(LTL|FTL|Flatbed|Dry Van|Reefer|Step Deck|Power Only)\b/i,
            ])
        );

        const weight = matchFirst(text, [
            /Weight[:\s]+([\d,.]+\s*(?:lbs?|pounds?|kg|tons?)?)/i,
            /([\d,.]+\s*(?:lbs?|pounds?))\b/i,
        ]);

        const priceRaw = matchFirst(text, [
            /(?:Rate|Price|Budget|Offer)[:\s]*\$?\s*([\d,.]+)/i,
            /\$\s*([\d,]+\.?\d*)/,
        ]);
        const price = priceRaw ? Number(priceRaw.replace(/,/g, "")) : null;

        const customerName = cleanCargoLabel(
            matchFirst(text, [
                /Customer[:\s]+([A-Za-z0-9 &.'-]{2,80})/i,
                /Shipper[:\s]+([A-Za-z0-9 &.'-]{2,80})/i,
                /Listed by[:\s]+([A-Za-z0-9 &.'-]{2,80})/i,
            ])
        );

        const imageUrl = matchFirst(html, [
            /src="(https?:\/\/[^"]+(?:uship|cloudinary|imgix|amazonaws)[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
            /src="(https?:\/\/[^"]+(?:uship|cloudinary|img)[^"]+)"/i,
            /(https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp))/i,
        ]);

        let shipmentTitle = extractTitleFromSubject(email.subject);
        if (!shipmentTitle || /^(instant\s+alert|new\s+shipment|saved\s+search)/i.test(shipmentTitle)) {
            shipmentTitle =
                vehicle ||
                [pickup.city && pickup.state ? `${pickup.city}, ${pickup.state}` : pickup.city, delivery.city && delivery.state ? `${delivery.city}, ${delivery.state}` : delivery.city]
                    .filter(Boolean)
                    .join(" → ") ||
                email.subject;
        }

        return {
            source: "USHIP",
            externalShipmentId: externalShipmentId || undefined,
            shipmentTitle,
            customerName: customerName || undefined,
            pickupCity: pickup.city,
            pickupState: pickup.state,
            pickupZip: pickup.zip,
            deliveryCity: delivery.city,
            deliveryState: delivery.state,
            deliveryZip: delivery.zip,
            pickupFrom: parseUsDate(pickupFromRaw),
            pickupTo: parseUsDate(pickupToRaw || pickupFromRaw),
            deliveryFrom: parseUsDate(deliveryFromRaw),
            deliveryTo: parseUsDate(deliveryToRaw || deliveryFromRaw),
            miles: Number.isFinite(miles as number) ? miles : null,
            category: category || undefined,
            equipment: equipment || undefined,
            vehicle: vehicle || undefined,
            weight: weight || undefined,
            price: Number.isFinite(price as number) ? price : null,
            imageUrl: imageUrl || undefined,
            viewUrl: viewUrl || undefined,
            receivedAt: email.receivedAt,
        };
    }
}

export const ushipParser = new UShipParser();

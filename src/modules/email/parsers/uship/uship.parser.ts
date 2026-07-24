import type { EmailParser, ParsedShipmentDraft, RawEmailMessage } from "../../models/types.js";

const USHIP_FROM = "no-reply@email.uship.com";
const SUBJECT_PREFIX = "new shipment -";

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
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

function extractTitleFromSubject(subject: string): string {
    const withoutPrefix = subject.replace(/^New shipment\s*-\s*/i, "").trim();
    return withoutPrefix.replace(/\s*-\s*Matches Your.*$/i, "").trim() || subject;
}

/**
 * Isolated uShip parser. Future sources (DAT, Truckstop, …) get their own parsers.
 */
export class UShipParser implements EmailParser {
    readonly source = "USHIP" as const;

    canParse(email: RawEmailMessage): boolean {
        const from = email.fromAddress.toLowerCase();
        const subject = email.subject.trim().toLowerCase();
        return from.includes(USHIP_FROM) && subject.startsWith(SUBJECT_PREFIX);
    }

    parse(email: RawEmailMessage): ParsedShipmentDraft | null {
        if (!this.canParse(email)) return null;

        const text = decodeEntities(
            [email.bodyText || "", email.bodyHtml ? stripHtml(email.bodyHtml) : "", email.snippet || ""].join("\n")
        );
        const html = email.bodyHtml || "";

        const viewUrl =
            matchFirst(html, [
                /href="(https?:\/\/[^"]*uship\.com[^"]+)"/i,
                /(https?:\/\/(?:www\.)?uship\.com\/[^\s"'<>]+)/i,
            ]) ||
            matchFirst(text, [/(https?:\/\/(?:www\.)?uship\.com\/[^\s"'<>]+)/i]);

        const externalShipmentId =
            matchFirst(viewUrl || "", [/\/(\d{5,})\b/]) ||
            matchFirst(text, [/Shipment\s*#?\s*:?\s*(\d{5,})/i]);

        const pickupLine = matchFirst(text, [
            /Pickup[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
            /From[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
        ]);
        const deliveryLine = matchFirst(text, [
            /Delivery[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
            /To[:\s]+([A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)/i,
        ]);

        const pickup = parseCityStateZip(pickupLine);
        const delivery = parseCityStateZip(deliveryLine);

        const pickupFromRaw = matchFirst(text, [
            /Pickup(?:\s+date)?(?:\s+from)?[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
            /Ready[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);
        const pickupToRaw = matchFirst(text, [
            /Pickup(?:\s+date)?(?:\s+to|[-–])\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);
        const deliveryFromRaw = matchFirst(text, [
            /Delivery(?:\s+date)?(?:\s+from)?[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
            /Deliver by[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);
        const deliveryToRaw = matchFirst(text, [
            /Delivery(?:\s+date)?(?:\s+to|[-–])\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
        ]);

        const milesRaw = matchFirst(text, [
            /(?:Distance|Miles)[:\s]+([\d,.]+)\s*(?:mi|miles)?/i,
            /([\d,.]+)\s*miles/i,
        ]);
        const miles = milesRaw ? Number(milesRaw.replace(/,/g, "")) : null;

        const category = matchFirst(text, [
            /Category[:\s]+([A-Za-z0-9 /&+-]+)/i,
            /Vehicle type[:\s]+([A-Za-z0-9 /&+-]+)/i,
        ]);

        const imageUrl = matchFirst(html, [
            /src="(https?:\/\/[^"]+(?:uship|cloudinary|img)[^"]+)"/i,
            /(https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp))/i,
        ]);

        return {
            source: "USHIP",
            externalShipmentId: externalShipmentId || undefined,
            shipmentTitle: extractTitleFromSubject(email.subject),
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
            imageUrl: imageUrl || undefined,
            viewUrl: viewUrl || undefined,
            receivedAt: email.receivedAt,
        };
    }
}

export const ushipParser = new UShipParser();

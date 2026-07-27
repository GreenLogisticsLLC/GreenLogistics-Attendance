/** Shared types for email → shipment import pipeline. */

export type ShipmentSource = "USHIP" | "DAT" | "CENTRAL_DISPATCH" | "TRUCKSTOP" | "SHIPLY" | "FREIGHTQUOTE" | "UNKNOWN";

export type ShipmentLeadStatus =
    | "NEW"
    | "ASSIGNED"
    | "AWAITING_ACCEPTANCE"
    | "FOLLOW_UP"
    | "QUOTE_SENT"
    | "NEGOTIATION"
    | "BOOKED"
    | "PICKED_UP"
    | "DELIVERED"
    | "WON"
    | "LOST"
    | "COMPLETED";

export type ImportLogEventType = "EmailImported" | "EmailIgnored" | "DuplicateShipment" | "ParseError" | "PipelineEvent";

export interface RawEmailMessage {
    gmailMessageId: string;
    gmailThreadId?: string;
    fromAddress: string;
    subject: string;
    snippet?: string;
    receivedAt: Date;
    bodyText?: string;
    bodyHtml?: string;
    rawHeaders?: string;
}

export interface ParsedShipmentDraft {
    source: ShipmentSource;
    externalShipmentId?: string;
    shipmentTitle: string;
    pickupCity?: string;
    pickupState?: string;
    pickupZip?: string;
    deliveryCity?: string;
    deliveryState?: string;
    deliveryZip?: string;
    pickupFrom?: Date | null;
    pickupTo?: Date | null;
    deliveryFrom?: Date | null;
    deliveryTo?: Date | null;
    miles?: number | null;
    category?: string;
    imageUrl?: string;
    viewUrl?: string;
    receivedAt?: Date;
}

export interface EmailParser {
    readonly source: ShipmentSource;
    canParse(email: RawEmailMessage): boolean;
    parse(email: RawEmailMessage): ParsedShipmentDraft | null;
}

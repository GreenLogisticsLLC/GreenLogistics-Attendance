/** Shared types for email → shipment import pipeline. */

export type ShipmentSource = "USHIP" | "DAT" | "CENTRAL_DISPATCH" | "TRUCKSTOP" | "SHIPLY" | "FREIGHTQUOTE" | "UNKNOWN";

export type ShipmentLeadStatus =
    | "NEW"
    | "UNASSIGNED"
    | "ASSIGNED"
    | "AWAITING_ACCEPTANCE"
    | "AGENT_OPEN"
    | "WORKING"
    | "FOLLOW_UP"
    | "BID_SUBMITTED"
    | "CUSTOMER_REPLIED"
    | "ACCEPTED"
    | "LOAD_CREATED"
    | "DISPATCH"
    | "COMPLETED"
    | "CLOSED"
    | "LOST"
    | "QUOTE_SENT"
    | "NEGOTIATION"
    | "BOOKED"
    | "PICKED_UP"
    | "DELIVERED"
    | "WON";

export type ImportLogEventType =
    | "EmailImported"
    | "EmailIgnored"
    | "DuplicateShipment"
    | "ParseError"
    | "PipelineEvent"
    | "SkippedBeforeCutoff"
    | "DismissedUnread";

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
    customerName?: string;
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
    equipment?: string;
    vehicle?: string;
    weight?: string;
    price?: number | null;
    imageUrl?: string;
    viewUrl?: string;
    receivedAt?: Date;
}

export interface EmailParser {
    readonly source: ShipmentSource;
    canParse(email: RawEmailMessage): boolean;
    parse(email: RawEmailMessage): ParsedShipmentDraft | null;
}

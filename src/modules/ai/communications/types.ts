export type WaitingState =
    | "WAITING_FOR_CARRIER"
    | "WAITING_FOR_CUSTOMER"
    | "WAITING_FOR_BROKER"
    | "WAITING_FOR_DOCUMENT"
    | "WAITING_FOR_SIGNATURE"
    | "WAITING_FOR_RESPONSE"
    | "WAITING_FOR_INTERNAL_REVIEW"
    | "NO_OUTSTANDING_WAIT"
    | "INCOMPLETE";

export type Direction = "INBOUND" | "OUTBOUND";
export type RequestLifecycle = "REQUESTED" | "RESPONDED" | "RECEIVED" | "RESOLVED" | "CANCELLED";
export type ResponseClass =
    | "NO_RESPONSE"
    | "POSITIVE_RESPONSE"
    | "NEGATIVE_RESPONSE"
    | "DOCUMENT_RECEIVED"
    | "UNCERTAIN";
export type CommPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type CommunicationSource = {
    type: string;
    id: string;
    label: string;
    at?: string | null;
};

export type CommunicationMessage = {
    id: string;
    sourceType: "BROKER_MAILBOX" | "EMAIL_MESSAGE" | "AI_ACTION";
    direction: Direction;
    participant: "BROKER" | "CARRIER" | "CUSTOMER" | "UNKNOWN";
    participantUncertain?: boolean;
    subject: string;
    snippet: string;
    at: string;
    gmailThreadId: string | null;
    threadKey: string;
    actionStatus?: string;
};

export type CommunicationRequest = {
    id: string;
    actionId?: string;
    requestType: string;
    documentType: string | null;
    requestedAt: string | null;
    lifecycle: RequestLifecycle;
    responseClass: ResponseClass;
    responseMessageId: string | null;
    resolvedAt: string | null;
};

export type Commitment = {
    messageId: string;
    subject: string | null;
    promisedDate: string | null;
    at: string;
};

export type LastContact = {
    at: string;
    direction: Direction;
    participant: CommunicationMessage["participant"];
    subject: string;
    messageId: string;
};

export type CommunicationRecommendation = {
    id: string;
    text: string;
    reason: string;
    priority: CommPriority;
    source?: string;
};

export type CommunicationContext = {
    entityType: "carrier" | "shipment";
    entityId: string;
    carrierId: string | null;
    shipmentLeadIds: string[];
    communicationStatus: "ACTIVE" | "EMPTY" | "INCOMPLETE";
    waitingFor: WaitingState;
    waitingSince: string | null;
    openRequests: CommunicationRequest[];
    unresolvedItems: string[];
    messages: CommunicationMessage[];
    threads: Array<{ threadKey: string; messageIds: string[]; uncertain: boolean }>;
    commitments: Commitment[];
    lastContact: LastContact | null;
    lastInbound: LastContact | null;
    lastOutbound: LastContact | null;
    latestResponse: ResponseClass;
    followUp: { needed: "YES" | "NO" | "UNCERTAIN"; reason: string };
    recommendations: CommunicationRecommendation[];
    sources: CommunicationSource[];
    incompleteContext: string[];
    groundingLabel: string;
};

export type WaitingInput = {
    actions: Array<{
        actionId: string;
        actionType: string;
        status: string;
        executedAt: string | Date | null;
        documentType?: string | null;
    }>;
    documents: Array<{
        documentId: string;
        documentType: string;
        status: string;
        uploadedAt: string | Date | null;
    }>;
    validations?: Array<{
        validationId: string;
        requiresReview: boolean;
        overallStatus: string;
        createdAt: string | Date | null;
    }>;
    messages: Array<{
        id: string;
        direction: Direction;
        participant?: CommunicationMessage["participant"];
        at: string | Date | null;
        subject?: string;
        snippet?: string;
    }>;
    shipmentStatus?: string | null;
    shipmentUpdatedAt?: string | Date | null;
    customerQuestionEvents?: Array<{ id: string; at: string | Date | null; resolved?: boolean }>;
    missingSignature?: boolean;
    incomplete?: boolean;
};

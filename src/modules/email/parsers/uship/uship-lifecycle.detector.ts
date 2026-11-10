import { prisma } from "../../../../config/database.js";
import { domainEventEngine } from "../../../shipment/services/domain-event.engine.js";
import { shipmentService } from "../../../shipment/services/shipment.service.js";
import { sseEmitToUser } from "../../../crm/services/realtime.hub.js";
import { normalizeStatus } from "../../../shipment/shipment.lifecycle.js";
import { platformNotificationService } from "../../../shipment/services/platform-notification.service.js";

/**
 * Sprint D — classify uShip emails into lifecycle events and update the same Shipment Card.
 */

export type UshipLifecycleKind =
    | "BID_SUBMITTED"
    | "QUOTE_SUBMITTED"
    | "CUSTOMER_REPLIED"
    | "CUSTOMER_RESPOND"
    | "CUSTOMER_QUESTION"
    | "AGENT_WORKING"
    | "BID_UPDATED"
    | "CUSTOMER_ACCEPTED"
    | "ACCEPTED_ANOTHER_COMPANY"
    | "LOAD_NUMBER_ASSIGNED"
    | "SHIPMENT_BOOKED"
    | "SHIPMENT_LOST"
    | "SHIPMENT_DELETED_BY_CUSTOMER"
    | "NEW_MESSAGE"
    | "COMPETITOR_QUOTE"
    | "QUOTE_DECLINED"
    | "NO_LONGER_NEEDED"
    | "UNKNOWN";

export type DetectedLifecycleEvent = {
    kind: UshipLifecycleKind;
    title: string;
    loadNumber?: string;
    domainEventType: string;
    targetStatus?: string;
};

function haystack(subject: string, body: string): string {
    return `${subject}\n${body}`.toLowerCase();
}

/** New listing / Instant Alert subjects — never treat as quote/bid confirmation. */
export function isNewListingAlertSubject(subject: string): boolean {
    const s = String(subject || "").toLowerCase();
    if (/quote\s+confirmation|bid\s+confirmation|bid\s+submitted|quote\s+submitted/.test(s)) {
        return false;
    }
    return (
        /\binstant\s+alert\b/.test(s) ||
        /\bmatches\s+your\b.{0,40}\bsaved\s+search\b/.test(s) ||
        /^new\s+shipment\b/.test(s.trim())
    );
}

/**
 * True only for real quote/bid confirmation language.
 * Rejects instructional / CTA copy common in Instant Alerts
 * ("once you have submitted a quote", "have you submitted a quote yet").
 */
export function isQuoteOrBidConfirmation(subjectH: string, hay: string): boolean {
    if (/quote\s+confirmation|bid\s+confirmation|bid\s+submitted|quote\s+submitted/.test(subjectH)) {
        return true;
    }
    if (
        /quote\s+confirmation|bid\s+confirmation|confirmation\s+of\s+your\s+(?:quote|bid)/.test(hay)
    ) {
        return true;
    }
    if (
        /we\s+received\s+your\s+(?:quote|bid)|(?:quote|bid)\s+was\s+submitted|successfully\s+(?:submitted|posted)\s+(?:your\s+)?(?:quote|bid)/.test(
            hay
        )
    ) {
        return true;
    }
    // Past-tense confirmation only — block "once/when/after/before/if/have you … submitted".
    const instructional =
        /(?:once|when|after|before|if|unless|until|should)\s+you\s+(?:have\s+)?(?:submitted|placed|posted)\s+a\s+(?:quote|bid)|have\s+you\s+(?:submitted|placed|posted)\s+a\s+(?:quote|bid)|submit\s+(?:a\s+)?(?:quote|bid)\s+now|place\s+(?:a\s+)?(?:quote|bid)\s+now/.test(
            hay
        );
    if (instructional) return false;
    if (
        /your\s+(?:quote|bid)\s+has\s+been\s+(?:submitted|received|confirmed|posted|placed)/.test(hay)
    ) {
        return true;
    }
    if (/you\s+(?:have\s+)?(?:submitted|placed|posted)\s+(?:a\s+|your\s+)?(?:quote|bid)/.test(hay)) {
        return true;
    }
    if (
        /(?:quote|bid)\s+(?:was\s+)?(?:placed|received)|placed\s+(?:a\s+|your\s+)?(?:quote|bid)|your\s+(?:quote|bid)\s+of\b|thanks?\s+you\s+for\s+(?:your\s+)?(?:quote|bid|quoting)|this\s+(?:email\s+)?confirms\s+(?:that\s+)?you\s+(?:have\s+)?placed/.test(
            hay
        )
    ) {
        return true;
    }
    return false;
}

/**
 * uShip "Booking Confirmation — CONGRATS! THIS CUSTOMER ACCEPTED YOUR QUOTE
 * AND THIS SHIPMENT IS NOW BOOKED". That is Accept Green, and the load number
 * is created from it.
 */
export function isBookingConfirmation(subject: string, hay: string): boolean {
    const subjectH = String(subject || "").toLowerCase();
    if (/\bbooking\s+confirmation\b/.test(subjectH)) return true;
    const blob = `${subjectH}\n${hay}`.toLowerCase();
    return (
        /this\s+customer\s+accepted\s+your\s+quote/.test(blob) &&
        /shipment\s+is\s+now\s+booked|booking\s+confirmation/.test(blob)
    );
}

/** Subject is a quote/bid receipt, not a customer win. */
function isQuoteConfirmationSubject(subject: string): boolean {
    const s = String(subject || "").toLowerCase();
    return /quote\s+confirmation|bid\s+confirmation|bid\s+submitted|quote\s+submitted|you\s+placed\s+a\s+(?:quote|bid)|placed\s+a\s+quote\s+on|your\s+quote\s+of\b/.test(
        s
    );
}

/**
 * Customer actually took OUR quote. A bid receipt, a question email, or
 * "if the customer accepted your quote" must not create a load.
 */
export function isExplicitCustomerWin(subject: string, hay: string): boolean {
    const subjectH = String(subject || "").toLowerCase();
    const subjectWin =
        /your\s+(?:quote|bid|offer)\s+(?:was|has\s+been)\s+accepted/.test(subjectH) ||
        /(?:customer|shipper)\s+accepted\s+your\s+(?:quote|bid|offer)/.test(subjectH) ||
        /accepted\s+your\s+(?:quote|bid|offer)/.test(subjectH) ||
        /\bbooking\s+confirm(?:ed|ation)\b/.test(subjectH) ||
        /this\s+customer\s+accepted\s+your\s+quote/.test(subjectH) ||
        /shipment\s+is\s+now\s+booked/.test(subjectH) ||
        /\bcongrats\b/.test(subjectH) ||
        /you(?:'ve|\s+have)\s+been\s+booked/.test(subjectH) ||
        /your\s+(?:listing|shipment)\s+(?:has\s+been\s+|was\s+)?booked/.test(subjectH) ||
        /congratulations/.test(subjectH);
    if (subjectWin) return true;
    if (isQuoteConfirmationSubject(subjectH)) return false;
    if (
        /question\s+answered|new\s+question|customer\s+(?:respond|replied|question)|message\s+from\s+(?:the\s+)?(?:customer|shipper)/.test(
            subjectH
        )
    ) {
        return false;
    }

    const withoutConditionals = hay
        .replace(
            /(?:\bif\b|\bwhen\b|\bonce\b|\bunless\b|\buntil\b|\bbefore\b|\bshould\b)\s+(?:the\s+)?(?:customer|shipper)\s+(?:has\s+)?accepted\s+your\s+(?:quote|bid|offer)/g,
            " "
        )
        .replace(
            /(?:\bif\b|\bwhen\b|\bonce\b|\bunless\b|\buntil\b)\s+your\s+(?:quote|bid|listing|shipment|code)\s+(?:is\s+|was\s+|has\s+been\s+)?(?:accepted|booked)/g,
            " "
        )
        .replace(
            /(?:\bnot\b|n't|has\s+not|have\s+not)\s+(?:yet\s+)?(?:been\s+)?(?:accepted|booked)/g,
            " "
        );

    return (
        /(?:the\s+)?(?:customer|shipper)\s+(?:has\s+)?accepted\s+your\s+(?:quote|bid|offer)/.test(
            withoutConditionals
        ) ||
        /your\s+(?:quote|bid|offer)\s+(?:was|has\s+been)\s+accepted/.test(withoutConditionals) ||
        /your\s+(?:listing|shipment)\s+(?:has\s+been|was)\s+booked/.test(withoutConditionals) ||
        /\bbooking\s+confirm(?:ed|ation)\b/.test(withoutConditionals) ||
        /this\s+customer\s+accepted\s+your\s+quote/.test(withoutConditionals) ||
        /shipment\s+is\s+now\s+booked/.test(withoutConditionals) ||
        /you(?:'ve|\s+have)\s+been\s+booked/.test(withoutConditionals) ||
        /your\s+code\s+has\s+been\s+accepted\s+by\s+(?:the\s+)?(?:customer|shipper)/.test(
            withoutConditionals
        ) ||
        /congratulations.{0,50}(?:accepted|booked)/.test(withoutConditionals)
    );
}

/** Short question + answer line from a uShip Question Answered email. */
export function customerAnswerExcerpt(subject: string, body: string): string {
    const text = `${subject}\n${body}`.replace(/\s+/g, " ").trim();
    const question = text.match(
        /\byour\s+question\b\s*[:\-]?\s*(?!\s*your\s+question\b)(.{2,220}?)(?=\s+\banswer\b|\s+shipment\s+name\b|$)/i
    );
    const answer = text.match(
        /\banswer\b\s*[:\-]?\s*(.{2,360}?)(?=\s+shipment\s+name\b|\s+pickup\b|\s+delivery\b|\s+submit\s+quote\b|\s+view\s+shipment\b|$)/i
    );
    const parts: string[] = [];
    if (question?.[1]) parts.push(`Question: ${question[1].trim()}`);
    if (answer?.[1]) parts.push(`Answer: ${answer[1].trim()}`);
    if (parts.length) return parts.join(" — ").slice(0, 500);
    return String(subject || "").trim().slice(0, 240);
}

function extractLoadNumber(text: string): string | undefined {
    const patterns = [
        /load\s*(?:number|#|no\.?)[:\s#-]*([A-Z0-9-]{3,})/i,
        /load\s*#\s*([A-Z0-9-]{3,})/i,
        /\bLN[:\s#-]*([A-Z0-9-]{4,})/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m?.[1]) return m[1].trim();
    }
    return undefined;
}

/** uShip "You've Got Competition" — another provider quoted on this listing. */
export function isCompetitorQuoteEmail(subject: string, hay: string): boolean {
    const blob = `${subject}\n${hay}`.toLowerCase();
    return /you'?ve\s+got\s+competition|another\s+provider\s+has\s+quoted|other\s+provider\s+has\s+quoted|another\s+(?:carrier|company|broker)\s+has\s+(?:quoted|placed\s+a\s+quote)|a\s+provider\s+has\s+quoted\s+on\s+this\s+shipment/.test(
        blob
    );
}

export function detectUshipLifecycleEvent(subject: string, body: string): DetectedLifecycleEvent {
    const h = haystack(subject, body);
    const loadNumber = extractLoadNumber(`${subject}\n${body}`);

    if (isCompetitorQuoteEmail(subject, h)) {
        return {
            kind: "COMPETITOR_QUOTE",
            title: "Another provider quoted",
            domainEventType: "COMPETITOR_QUOTE",
        };
    }

    if (
        /listing\s+(?:was\s+)?deleted|shipment\s+(?:was\s+)?deleted|deleted\s+(?:this\s+)?(?:listing|shipment)|customer\s+deleted|removed\s+(?:the\s+)?(?:listing|shipment)|no\s+longer\s+available|listing\s+has\s+been\s+removed|shipment\s+has\s+been\s+removed/.test(
            h
        )
    ) {
        return {
            kind: "SHIPMENT_DELETED_BY_CUSTOMER",
            title: "Deleted from Customer",
            domainEventType: "SHIPMENT_DELETED_BY_CUSTOMER",
            targetStatus: "DELETED_FROM_CUSTOMER",
        };
    }

    // Broker quote declined because customer took someone else's quote.
    // ONLY this Decline Reason → Accepted to another company (not generic "another company" text).
    if (
        /decline\s*reason[\s\S]{0,160}?accepted\s+another\s+quote/.test(h) ||
        (/this\s+quote\s+was\s+declined/.test(h) &&
            /accepted\s+another\s+quote/.test(h) &&
            /decline\s*reason/.test(h))
    ) {
        return {
            kind: "ACCEPTED_ANOTHER_COMPANY",
            title: "Accepted another company",
            domainEventType: "SHIPMENT_ACCEPTED_ANOTHER_COMPANY",
            targetStatus: "ACCEPTED_ANOTHER_COMPANY",
        };
    }

    // Customer deleted the listing. Decline reason: shipping/shipper no longer needed or required.
    if (
        /(?:shipper|shipping)\s+no\s+longer\s+(?:needed|required)/.test(h) ||
        /decline\s*reason[\s\S]{0,240}?(?:shipper|shipping)\s+no\s+longer\s+(?:needed|required)/.test(h)
    ) {
        return {
            kind: "NO_LONGER_NEEDED",
            title: "No longer needed",
            domainEventType: "NO_LONGER_NEEDED",
            targetStatus: "NO_LONGER_NEEDED",
        };
    }

    // Customer turned down this quote. Shown on the shipment; does not invent an accept.
    if (
        /this\s+quote\s+was\s+declined|your\s+quote\s+was\s+declined|your\s+bid\s+was\s+declined|customer\s+declined\s+(?:your\s+)?(?:quote|bid|shipment)|declined\s+your\s+(?:quote|bid)/.test(
            h
        )
    ) {
        return {
            kind: "QUOTE_DECLINED",
            title: "Customer declined",
            domainEventType: "QUOTE_DECLINED",
        };
    }

    if (
        /shipment\s+lost|listing\s+closed|bid\s+not\s+selected|unfortunately.{0,40}lost|canceled|cancelled/.test(
            h
        )
    ) {
        return {
            kind: "SHIPMENT_LOST",
            title: "Shipment Lost",
            domainEventType: "SHIPMENT_LOST",
            targetStatus: "LOST",
        };
    }

    if (isBookingConfirmation(subject, h)) {
        return {
            kind: "CUSTOMER_ACCEPTED",
            title: "Accept Green",
            domainEventType: "CUSTOMER_ACCEPTED",
            targetStatus: "ACCEPT_GREEN",
        };
    }

    // A quote receipt is only Bid Submitted — never Accept Green / Load Created,
    // even when the footer says "if the customer accepted your quote".
    const subjectHEarly = String(subject || "").toLowerCase();
    if (isQuoteConfirmationSubject(subjectHEarly)) {
        return {
            kind: /bid/.test(subjectHEarly) && !/quote/.test(subjectHEarly) ? "BID_SUBMITTED" : "QUOTE_SUBMITTED",
            title: /bid/.test(subjectHEarly) && !/quote/.test(subjectHEarly) ? "Bid Submitted" : "Quote Submitted",
            domainEventType: "BID_SUBMITTED",
            targetStatus: "BID_SUBMITTED",
        };
    }

    // Our broker won — Accept Green. Must be an explicit win, not a bid receipt.
    if (isExplicitCustomerWin(subject, h)) {
        return {
            kind: "CUSTOMER_ACCEPTED",
            title: "Accept Green",
            domainEventType: "CUSTOMER_ACCEPTED",
            targetStatus: "ACCEPT_GREEN",
        };
    }

    // Explicit load-number emails only — never from a bare "Load #" substring in other mail.
    if (
        /load\s*(number|#)\s*(assigned|issued|is|created|received)|your\s+load\s*(number|#)/.test(h) &&
        loadNumber
    ) {
        return {
            kind: "LOAD_NUMBER_ASSIGNED",
            title: "Load Number Received",
            loadNumber,
            domainEventType: "LOAD_CREATED",
            targetStatus: "LOAD_CREATED",
        };
    }

    // Instant Alert / new listing — NEVER Customer Replied / Bid Submitted.
    // Must run before "new message" / Q&A patterns (Alert bodies often say "new message").
    const subjectH = String(subject || "").toLowerCase();
    if (isNewListingAlertSubject(subjectH)) {
        return {
            kind: "UNKNOWN",
            title: "uShip Instant Alert",
            domainEventType: "STATUS_CHANGED",
        };
    }

    // Customer reply/question BEFORE quote-confirmation — uShip footers often mention "your quote".
    if (
        /customer\s+question|asked\s+a\s+question|new\s+question|question\s+from\s+(?:the\s+)?customer|you\s+have\s+a\s+new\s+question/.test(
            h
        ) &&
        !/respond\s+to|response\s+to|answered|replied/.test(h)
    ) {
        return {
            kind: "CUSTOMER_QUESTION",
            title: "Customer Question",
            domainEventType: "CUSTOMER_RESPOND",
            targetStatus: "CUSTOMER_REPLIED",
        };
    }

    if (
        /customer\s+respond|customer\s+responded|respond\s+to\s+(?:your\s+)?(?:question|code)|response\s+to\s+(?:your\s+)?(?:question|code)|question\s+answered|code\s+answered|response\s+from\s+(?:the\s+)?customer|customer\s+has\s+responded|answered\s+your\s+question|reply\s+to\s+your\s+(?:question|code|quote)|customer\s+replied|new\s+reply|replied\s+to\s+your|new\s+message\s+from\s+(?:the\s+)?(?:customer|shipper)|shipper\s+(?:responded|replied)|customer\s+sent\s+you|new\s+message\s+(?:regarding|about)\s+your/.test(
            h
        )
    ) {
        return {
            kind: "CUSTOMER_RESPOND",
            title: "Customer Respond",
            domainEventType: "CUSTOMER_RESPOND",
            targetStatus: "CUSTOMER_REPLIED",
        };
    }

    // Require customer/shipper context — bare "new message" matches Instant Alert footers.
    if (
        /message\s+from\s+(?:the\s+)?customer|message\s+from\s+(?:the\s+)?shipper|customer\s+(?:sent\s+)?(?:you\s+)?(?:a\s+)?message|shipper\s+(?:sent\s+)?(?:you\s+)?(?:a\s+)?message/.test(
            h
        )
    ) {
        return {
            kind: "CUSTOMER_RESPOND",
            title: "Customer Respond",
            domainEventType: "CUSTOMER_RESPOND",
            targetStatus: "CUSTOMER_REPLIED",
        };
    }

    if (/bid\s+updated|updated\s+your\s+bid|quote\s+updated/.test(h)) {
        return {
            kind: "BID_UPDATED",
            title: "Bid Updated",
            domainEventType: "BID_SUBMITTED",
            targetStatus: "BID_SUBMITTED",
        };
    }

    // uShip "Quote Confirmation" / "Bid Submitted" — subject first; body only for
    // clear past-tense confirmations (not "once you have submitted a quote" CTAs).
    if (isQuoteOrBidConfirmation(subjectH, h)) {
        return {
            kind: /quote/.test(h) ? "QUOTE_SUBMITTED" : "BID_SUBMITTED",
            title: /quote/.test(h) ? "Quote Submitted" : "Bid Submitted",
            domainEventType: "BID_SUBMITTED",
            targetStatus: "BID_SUBMITTED",
        };
    }

    if (
        /your\s+(?:code|question)\s+has\s+been\s+completed|(?:code|question)\s+has\s+been\s+completed/.test(
            h
        )
    ) {
        return {
            kind: "AGENT_WORKING",
            title: "Agent Working",
            domainEventType: "AGENT_STARTED_WORK",
            targetStatus: "WORKING",
        };
    }

    return {
        kind: "UNKNOWN",
        title: "uShip email",
        domainEventType: "STATUS_CHANGED",
    };
}

const NOTIFY_KINDS = new Set<UshipLifecycleKind>([
    "CUSTOMER_REPLIED",
    "CUSTOMER_RESPOND",
    "CUSTOMER_QUESTION",
    "AGENT_WORKING",
    "CUSTOMER_ACCEPTED",
    "ACCEPTED_ANOTHER_COMPANY",
    "LOAD_NUMBER_ASSIGNED",
    "SHIPMENT_BOOKED",
    "SHIPMENT_LOST",
    "SHIPMENT_DELETED_BY_CUSTOMER",
    "NEW_MESSAGE",
    "BID_SUBMITTED",
    "BID_UPDATED",
    "QUOTE_SUBMITTED",
    "COMPETITOR_QUOTE",
    "QUOTE_DECLINED",
]);

/**
 * Apply detected lifecycle event onto the existing Shipment Card (never creates a new record).
 */
export async function applyUshipLifecycleEvent(input: {
    shipmentLeadId: string;
    subject: string;
    body: string;
    actorUserId?: string;
    gmailMessageId?: string;
    source?: string;
}) {
    const detected = detectUshipLifecycleEvent(input.subject, input.body);
    const shipment = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: input.shipmentLeadId },
    });
    if (!shipment) return { applied: false as const, detected };

    if (
        (detected.kind === "COMPETITOR_QUOTE" ||
            detected.kind === "QUOTE_DECLINED" ||
            detected.kind === "NO_LONGER_NEEDED") &&
        input.gmailMessageId
    ) {
        const already = await prisma.domainEvent.findFirst({
            where: {
                shipmentLeadId: input.shipmentLeadId,
                eventType: detected.domainEventType,
                payloadJson: { contains: input.gmailMessageId },
            },
            select: { eventId: true },
        });
        if (already) {
            return {
                applied: false as const,
                detected,
                reason: "Competition email already on this shipment",
            };
        }
    }

    // AAC only from the assigned broker's Gmail Decline Reason email —
    // never from company Instant Alert / loose "another company" body text.
    if (
        detected.kind === "ACCEPTED_ANOTHER_COMPANY" &&
        input.source !== "broker_gmail"
    ) {
        return {
            applied: false as const,
            detected,
            reason: "Accepted another company requires broker Gmail Decline Reason email",
        };
    }

    // Never promote Bid Submitted from Instant Alert / new-listing subjects.
    if (
        (detected.kind === "BID_SUBMITTED" ||
            detected.kind === "QUOTE_SUBMITTED" ||
            detected.kind === "BID_UPDATED") &&
        isNewListingAlertSubject(input.subject)
    ) {
        return {
            applied: false as const,
            detected,
            reason: "Instant Alert / new listing email cannot set Bid Submitted",
        };
    }

    const customerReplyKinds = new Set<UshipLifecycleKind>([
        "CUSTOMER_RESPOND",
        "CUSTOMER_QUESTION",
        "CUSTOMER_REPLIED",
        "NEW_MESSAGE",
    ]);

    // Old emails rematched by soft title ("1 Pallet") must not stamp Bid Submitted
    // or Customer Replied onto a newer Instant Alert card.
    const ageSensitiveKinds = new Set<UshipLifecycleKind>([
        "BID_SUBMITTED",
        "QUOTE_SUBMITTED",
        "BID_UPDATED",
        "CUSTOMER_RESPOND",
        "CUSTOMER_QUESTION",
        "CUSTOMER_REPLIED",
        "NEW_MESSAGE",
    ]);
    if (ageSensitiveKinds.has(detected.kind)) {
        let mailReceivedAt: Date | null = null;
        if (input.gmailMessageId) {
            const mail = await prisma.brokerMailboxMessage.findFirst({
                where: { gmailMessageId: input.gmailMessageId },
                select: { receivedAt: true },
            });
            mailReceivedAt = mail?.receivedAt || null;
            if (!mailReceivedAt) {
                const companyMail = await prisma.emailMessage.findFirst({
                    where: { gmailMessageId: input.gmailMessageId },
                    select: { receivedAt: true },
                });
                mailReceivedAt = companyMail?.receivedAt || null;
            }
        }
        if (mailReceivedAt && shipment.createdAt) {
            // Allow small clock skew; reject mail clearly older than the card.
            const skewMs = 2 * 60_000;
            if (mailReceivedAt.getTime() + skewMs < shipment.createdAt.getTime()) {
                return {
                    applied: false as const,
                    detected,
                    reason: customerReplyKinds.has(detected.kind)
                        ? "Customer reply email is older than this shipment card"
                        : "Quote/bid confirmation email is older than this shipment card",
                };
            }
        }
    }

    // Idempotency: never re-apply the same Gmail message as Customer Respond.
    // Rematch used to re-emit CUSTOMER_RESPOND with a fresh timestamp after the
    // broker clicked the green lamp — red incorrectly won on card reopen.
    if (customerReplyKinds.has(detected.kind)) {
        if (input.gmailMessageId) {
            const already = await prisma.domainEvent.findFirst({
                where: {
                    shipmentLeadId: input.shipmentLeadId,
                    eventType: {
                        in: [
                            "CUSTOMER_RESPOND",
                            "CUSTOMER_REPLIED",
                            "CUSTOMER_QUESTION",
                            "NEW_MESSAGE",
                        ],
                    },
                    payloadJson: { contains: input.gmailMessageId },
                },
                select: { eventId: true },
            });
            if (already) {
                return {
                    applied: false as const,
                    detected,
                    reason: "Customer reply Gmail already applied (idempotent)",
                };
            }
            // First delivery always lands on the card, even if the broker already
            // clicked the green lamp. Rematch of the same Gmail id stops above,
            // so a later green click is not overwritten by an old email.
        } else {
            // Without a Gmail id we cannot tell new vs rematch — never override a
            // newer green Broker Answer (red is Gmail-only).
            const latestBroker = await prisma.domainEvent.findFirst({
                where: {
                    shipmentLeadId: input.shipmentLeadId,
                    eventType: { in: ["BROKER_QUESTION", "BROKER_ANSWER"] },
                },
                orderBy: { createdAt: "desc" },
                select: { createdAt: true },
            });
            if (latestBroker) {
                const latestCustomer = await prisma.domainEvent.findFirst({
                    where: {
                        shipmentLeadId: input.shipmentLeadId,
                        eventType: {
                            in: [
                                "CUSTOMER_RESPOND",
                                "CUSTOMER_REPLIED",
                                "CUSTOMER_QUESTION",
                                "NEW_MESSAGE",
                            ],
                        },
                    },
                    orderBy: { createdAt: "desc" },
                    select: { createdAt: true },
                });
                if (
                    !latestCustomer ||
                    latestBroker.createdAt.getTime() >= latestCustomer.createdAt.getTime()
                ) {
                    return {
                        applied: false as const,
                        detected,
                        reason: "Customer reply requires Gmail message after Broker Answer",
                    };
                }
            }
        }
    }

    // Authoritative mailbox gate:
    // - before assignment: only company Gmail may mutate the card
    // - after assignment: assigned broker Gmail is preferred
    // - exception: customer Q&A replies ("Question Answered") may also arrive on
    //   company Gmail; still light the red lamp and notify the assigned broker
    const source = input.source || "uship_email";
    const assignedBrokerId = shipment.assignedBrokerId || null;
    if (assignedBrokerId) {
        const fromAssignedBroker =
            source === "broker_gmail" && input.actorUserId === assignedBrokerId;
        const fromCompanyCustomerReply =
            source === "company_gmail" && customerReplyKinds.has(detected.kind);
        if (!fromAssignedBroker && !fromCompanyCustomerReply) {
            return {
                applied: false as const,
                detected,
                reason: "Follow-up updates are accepted only from the assigned broker Gmail",
            };
        }
    } else if (source === "broker_gmail") {
        return {
            applied: false as const,
            detected,
            reason: "Shipment is not assigned yet; wait for company inbox assignment",
        };
    }

    // Load number on SAME card — only after Customer Accepted.
    // GreenOS always allocates GL100001… — never accept external/manual load numbers.
    if (detected.kind === "LOAD_NUMBER_ASSIGNED") {
        const current = normalizeStatus(shipment.status);
        const loadReady = [
            "ACCEPT_GREEN",
            "ACCEPTED",
            "LOAD_CREATED",
            "CARRIER_ASSIGNED",
            "RATE_CON_GENERATED",
            "CARRIER_ACCEPTED",
            "PICKUP",
            "IN_TRANSIT",
            "DELIVERED",
            "POD_UPLOADED",
            "CUSTOMER_INVOICE",
            "CARRIER_PAYMENT",
            "DISPATCH",
            "COMPLETED",
            "CLOSED",
        ].includes(current);
        if (!loadReady) {
            return {
                applied: false as const,
                detected,
                reason: "Load Number ignored until Customer Accepted arrives on Gmail",
            };
        }
        if (!shipment.loadNumber) {
            await shipmentService.createLoadAfterAccepted({
                shipmentLeadId: input.shipmentLeadId,
                actorUserId: input.actorUserId,
            });
        }
    } else if (detected.targetStatus) {
        const current = normalizeStatus(shipment.status);
        const target = normalizeStatus(detected.targetStatus);
        // Don't regress past load/dispatch/completed unless LOST / deleted by customer
        const rank: Record<string, number> = {
            NEW: 0,
            UNASSIGNED: 0,
            AWAITING_ACCEPTANCE: 1,
            AGENT_OPEN: 1.5,
            WORKING: 2,
            BID_SUBMITTED: 3,
            CUSTOMER_REPLIED: 4,
            FOLLOW_UP: 4,
            BROKER_REPLY: 4,
            ACCEPT_GREEN: 5,
            ACCEPTED: 5,
            LOAD_CREATED: 6,
            CARRIER_ASSIGNED: 6.2,
            RATE_CON_GENERATED: 6.4,
            CARRIER_ACCEPTED: 6.6,
            PICKUP: 6.8,
            IN_TRANSIT: 7,
            DELIVERED: 7.2,
            POD_UPLOADED: 7.4,
            CUSTOMER_INVOICE: 7.6,
            CARRIER_PAYMENT: 7.8,
            DISPATCH: 7,
            COMPLETED: 8,
            CLOSED: 9,
            LOST: 9,
            ACCEPTED_ANOTHER_COMPANY: 9,
            DELETED_FROM_CUSTOMER: 9,
            NO_LONGER_NEEDED: 9,
        };
        const alreadyWon = current === "ACCEPT_GREEN" || (rank[current] ?? 0) >= 5;
        const shouldUpdateStatus =
            detected.targetStatus === "LOST" ||
            detected.targetStatus === "DELETED_FROM_CUSTOMER" ||
            detected.targetStatus === "NO_LONGER_NEEDED" ||
            (detected.targetStatus === "ACCEPTED_ANOTHER_COMPANY" && !alreadyWon) ||
            ((rank[target] ?? 0) >= (rank[current] ?? 0) &&
                !(detected.targetStatus === "ACCEPTED_ANOTHER_COMPANY" && alreadyWon));

        if (shouldUpdateStatus && current !== target) {
            await shipmentService.transitionStatus({
                shipmentLeadId: input.shipmentLeadId,
                status: target,
                actorUserId: input.actorUserId,
                skipLifecycleCheck: true,
            });
            if (
                detected.kind === "CUSTOMER_RESPOND" ||
                detected.kind === "CUSTOMER_QUESTION" ||
                detected.kind === "CUSTOMER_REPLIED" ||
                detected.kind === "NEW_MESSAGE"
            ) {
                await domainEventEngine.emit({
                    shipmentLeadId: input.shipmentLeadId,
                    eventType: "CUSTOMER_RESPOND",
                    title: detected.title,
                    message: customerAnswerExcerpt(input.subject, input.body),
                    actorUserId: input.actorUserId,
                    payload: {
                        source: input.source || "uship_email",
                        gmailMessageId: input.gmailMessageId,
                        kind: detected.kind,
                    },
                    timelineStage: "CUSTOMER_RESPOND",
                });
            } else if (
                detected.kind === "BID_SUBMITTED" ||
                detected.kind === "QUOTE_SUBMITTED" ||
                detected.kind === "BID_UPDATED"
            ) {
                await domainEventEngine.emit({
                    shipmentLeadId: input.shipmentLeadId,
                    eventType: "BID_SUBMITTED",
                    title: "Bid Submitted",
                    message: input.subject,
                    actorUserId: input.actorUserId,
                    payload: {
                        source: input.source || "uship_email",
                        gmailMessageId: input.gmailMessageId,
                        kind: detected.kind,
                    },
                    timelineStage: "BID_SUBMITTED",
                });
            }
        } else {
            await domainEventEngine.emit({
                shipmentLeadId: input.shipmentLeadId,
                eventType: detected.domainEventType,
                title: detected.title,
                message: input.subject,
                actorUserId: input.actorUserId,
                payload: {
                    source: input.source || "uship_email",
                    gmailMessageId: input.gmailMessageId,
                    kind: detected.kind,
                    statusUnchanged: true,
                    currentStatus: shipment.status,
                },
                timelineStage: detected.domainEventType,
            });
        }

        // After Accept Green → auto-generate Load Number and move to Create Load.
        // Do not create a load when another company won.
        if (
            (detected.kind === "CUSTOMER_ACCEPTED" || detected.kind === "SHIPMENT_BOOKED") &&
            target === "ACCEPT_GREEN"
        ) {
            await shipmentService
                .createLoadAfterAccepted({
                    shipmentLeadId: input.shipmentLeadId,
                    actorUserId: input.actorUserId,
                })
                .catch((err) => {
                    console.warn(
                        "[lifecycle] auto load after Accepted failed:",
                        err instanceof Error ? err.message : err
                    );
                });
            // Refresh so SSE / notifications carry the new GL# and Create Load hint.
            const refreshed = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: input.shipmentLeadId },
                select: {
                    loadNumber: true,
                    status: true,
                    customerName: true,
                    customerEmail: true,
                    customerPhone: true,
                },
            });
            if (refreshed) {
                shipment.loadNumber = refreshed.loadNumber;
                shipment.status = refreshed.status;
                (shipment as { customerName?: string | null }).customerName = refreshed.customerName;
                (shipment as { customerEmail?: string | null }).customerEmail = refreshed.customerEmail;
                (shipment as { customerPhone?: string | null }).customerPhone =
                    refreshed.customerPhone;
            }
        }
    } else {
        await domainEventEngine.emit({
            shipmentLeadId: input.shipmentLeadId,
            eventType: detected.domainEventType,
            title: detected.title,
            message: input.subject,
            actorUserId: input.actorUserId,
            payload: {
                source: input.source || "uship_email",
                gmailMessageId: input.gmailMessageId,
                kind: detected.kind,
            },
                timelineStage:
                    detected.kind === "COMPETITOR_QUOTE" || detected.kind === "QUOTE_DECLINED"
                        ? detected.kind
                        : "USHIP_EMAIL",
        });
    }

    // Keep Q&A history intact — display already shows only the latest trusted items.
    // Destructive prune/delete can erase the correct Customer Respond after a bad match.
    const customerKinds = new Set([
        "CUSTOMER_RESPOND",
        "NEW_MESSAGE",
        "CUSTOMER_QUESTION",
        "CUSTOMER_REPLIED",
    ]);
    if (
        customerKinds.has(detected.kind) ||
        customerKinds.has(String(detected.domainEventType || ""))
    ) {
        await domainEventEngine.correspondenceForDisplay(input.shipmentLeadId);
        try {
            const { armBrokerReplyDeadline } = await import(
                "../../../crm/services/broker-response-problem.service.js"
            );
            await armBrokerReplyDeadline(input.shipmentLeadId);
        } catch (err) {
            console.warn(
                "[lifecycle] arm brokerReplyDeadline failed:",
                err instanceof Error ? err.message : err
            );
        }
    }

    if (NOTIFY_KINDS.has(detected.kind)) {
        const booked =
            detected.kind === "CUSTOMER_ACCEPTED" || detected.kind === "SHIPMENT_BOOKED";
        const needsCustomerInfo =
            booked &&
            !(
                String(shipment.customerName || "").trim().length >= 2 &&
                (String(shipment.customerEmail || "").includes("@") ||
                    String(shipment.customerPhone || "").replace(/\D/g, "").length >= 10)
            );
        const payload = {
            type: "SHIPMENT_LIFECYCLE",
            kind: detected.kind,
            title: detected.title,
            shipmentLeadId: input.shipmentLeadId,
            greenOsShipmentId: shipment.greenOsShipmentId,
            shipmentNumber: shipment.greenOsShipmentId || input.shipmentLeadId.slice(0, 8),
            subject: input.subject,
            loadNumber: detected.loadNumber || shipment.loadNumber,
            assignedBrokerId: shipment.assignedBrokerId || null,
            openCreateLoad: booked && Boolean(shipment.loadNumber),
            needsCustomerInfo,
            at: new Date().toISOString(),
        };
        if (shipment.assignedBrokerId) {
            sseEmitToUser(shipment.assignedBrokerId, payload);
        }

        const typeMap: Record<string, string> = {
            CUSTOMER_REPLIED: "CUSTOMER_REPLIED",
            CUSTOMER_RESPOND: "CUSTOMER_RESPOND",
            CUSTOMER_QUESTION: "CUSTOMER_QUESTION",
            AGENT_WORKING: "AGENT_WORKING",
            NEW_MESSAGE: "CUSTOMER_RESPOND",
            CUSTOMER_ACCEPTED: "BID_ACCEPTED",
            ACCEPTED_ANOTHER_COMPANY: "SHIPMENT_ACCEPTED_ANOTHER_COMPANY",
            SHIPMENT_BOOKED: "SHIPMENT_BOOKED",
            LOAD_NUMBER_ASSIGNED: "LOAD_NUMBER_RECEIVED",
            SHIPMENT_LOST: "SHIPMENT_LOST",
            SHIPMENT_DELETED_BY_CUSTOMER: "SHIPMENT_DELETED_BY_CUSTOMER",
            BID_SUBMITTED: "BID_SUBMITTED",
            BID_UPDATED: "BID_SUBMITTED",
            QUOTE_SUBMITTED: "BID_SUBMITTED",
            COMPETITOR_QUOTE: "COMPETITOR_QUOTE",
            QUOTE_DECLINED: "QUOTE_DECLINED",
        };
        const nType = typeMap[detected.kind] || "TIMELINE_EVENT";
        const msg = `Shipment # ${shipment.greenOsShipmentId || input.shipmentLeadId.slice(0, 8)} — ${input.subject}`;
        if (shipment.assignedBrokerId) {
            await platformNotificationService
                .notifyUser({
                    userId: shipment.assignedBrokerId,
                    notificationType: nType,
                    title: detected.title,
                    message: msg,
                    shipmentLeadId: input.shipmentLeadId,
                    meta: { kind: detected.kind },
                })
                .catch(() => null);
        }
        const { notifyOpsAndOwningTeamLead } = await import(
            "../../../../services/team-notify.service.js"
        );
        await notifyOpsAndOwningTeamLead({
            assignedBrokerId: shipment.assignedBrokerId,
            ssePayload: payload,
            broadcastType: "SHIPMENT_LIFECYCLE_BROADCAST",
            notificationType: nType,
            title: detected.title,
            message: msg,
            shipmentLeadId: input.shipmentLeadId,
            meta: { kind: detected.kind },
        });
    }

    // Gmail "listing/shipment deleted" → remove the card from CRM entirely.
    if (detected.kind === "SHIPMENT_DELETED_BY_CUSTOMER") {
        try {
            await shipmentService.purgeShipmentLead(input.shipmentLeadId);
            return { applied: true as const, detected, purged: true as const };
        } catch (err) {
            console.warn(
                "[lifecycle] purge after deleted-by-customer failed:",
                err instanceof Error ? err.message : err
            );
        }
    }

    return { applied: true as const, detected };
}

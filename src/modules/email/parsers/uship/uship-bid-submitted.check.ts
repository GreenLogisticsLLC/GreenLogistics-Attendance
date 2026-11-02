/**
 * Guards against false Bid Submitted on Instant Alerts / instructional CTAs.
 *   npx tsx src/modules/email/parsers/uship/uship-bid-submitted.check.ts
 */
import {
    detectUshipLifecycleEvent,
    isCompetitorQuoteEmail,
    isExplicitCustomerWin,
    isNewListingAlertSubject,
    isQuoteOrBidConfirmation,
} from "./uship-lifecycle.detector.js";

function assert(cond: unknown, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exit(1);
    }
}

assert(
    isNewListingAlertSubject("INSTANT ALERT - Matches Your Green Saved Search"),
    "instant alert subject"
);
assert(
    isNewListingAlertSubject("New shipment - 4 Pallets - Matches Your Green Saved Search"),
    "new shipment saved search"
);
assert(
    !isNewListingAlertSubject("Quote Confirmation - 4 Pallets"),
    "quote confirmation is not listing alert"
);

const instant = detectUshipLifecycleEvent(
    "INSTANT ALERT - Matches Your Green Saved Search",
    `
Myrtle Beach, SC 29577
Andalusia, PA 19020
4 Pallets
Submit Quote Now
Once you have submitted a quote the customer may reply.
Have you submitted a quote yet?
Place a bid today
https://www.uship.com/shipment/4-pallets/123456789/
`
);
assert(instant.kind === "UNKNOWN", `instant kind=${instant.kind}`);
assert(!instant.targetStatus, "instant must not target Bid Submitted");

const instructional = detectUshipLifecycleEvent(
    "Matches Your Green Saved Search",
    "You have placed a quote on this shipment? No — Place a bid today. Once you have submitted a quote…"
);
assert(instructional.kind === "UNKNOWN", `instructional kind=${instructional.kind}`);

const realQuote = detectUshipLifecycleEvent(
    "Quote Confirmation - 4 Pallets",
    "Your quote has been submitted for Myrtle Beach to Andalusia."
);
assert(realQuote.kind === "QUOTE_SUBMITTED", `real quote kind=${realQuote.kind}`);
assert(realQuote.targetStatus === "BID_SUBMITTED", "real quote target");

const realBody = detectUshipLifecycleEvent(
    "uShip notification",
    "Thank you. We received your quote for this listing."
);
assert(realBody.kind === "QUOTE_SUBMITTED", `real body kind=${realBody.kind}`);

const placed = detectUshipLifecycleEvent(
    "You placed a quote on Steel structure",
    "This email confirms that you have placed a quote."
);
assert(placed.kind === "QUOTE_SUBMITTED", `placed quote kind=${placed.kind}`);
assert(placed.targetStatus === "BID_SUBMITTED", "placed quote target");

assert(
    isQuoteOrBidConfirmation("quote confirmation - 4 pallets", "generic"),
    "subject confirmation"
);
assert(
    !isQuoteOrBidConfirmation(
        "instant alert",
        "once you have submitted a quote submit quote now"
    ),
    "instructional body rejected"
);

const quoteWithConditional = detectUshipLifecycleEvent(
    "You placed a quote on 2 heavy equipment items for transport",
    `You placed a quote of $5,425.00.
If the customer accepted your quote, we will send a booking confirmation.
Other listings: this shipment booked last week.
Your listing has been booked only after the shipper accepts.`
);
assert(
    quoteWithConditional.kind === "QUOTE_SUBMITTED" || quoteWithConditional.kind === "BID_SUBMITTED",
    `quote with conditional accept kind=${quoteWithConditional.kind}`
);
assert(quoteWithConditional.targetStatus === "BID_SUBMITTED", "conditional quote stays a bid");
assert(
    !isExplicitCustomerWin(
        "You placed a quote on 2 heavy equipment items for transport",
        "If the customer accepted your quote, we will email you. shipment booked"
    ),
    "conditional language is not a win"
);

const realWin = detectUshipLifecycleEvent(
    "Your quote has been accepted",
    "The customer accepted your quote. Booking confirmed."
);
assert(realWin.kind === "CUSTOMER_ACCEPTED", `real win kind=${realWin.kind}`);
assert(realWin.targetStatus === "ACCEPT_GREEN", "real win creates Accept Green");

const question = detectUshipLifecycleEvent(
    "Question Answered - 2 heavy equipment items for transport",
    "The customer has responded. If the customer accepted your quote you would see Booking confirmed."
);
assert(question.kind === "CUSTOMER_RESPOND", `question kind=${question.kind}`);

const competition = detectUshipLifecycleEvent(
    "You've Got Competition - 30 Crates - A OTHER PROVIDER HAS QUOTED ON THIS SHIPMENT",
    "Another provider has quoted on this shipment. Your quote is still active."
);
assert(competition.kind === "COMPETITOR_QUOTE", `competition kind=${competition.kind}`);
assert(!competition.targetStatus, "competition must not change shipment status");
assert(
    isCompetitorQuoteEmail(
        "You've Got Competition - 30 Crates",
        "A OTHER PROVIDER HAS QUOTED ON THIS SHIPMENT"
    ),
    "competition subject"
);
assert(
    !isExplicitCustomerWin(
        "You've Got Competition - 30 Crates",
        "Another provider has quoted on this shipment"
    ),
    "competition is not Accept Green"
);

const declined = detectUshipLifecycleEvent(
    "Your quote was declined",
    "THIS QUOTE WAS DECLINED\nDECLINE REASON\nPrice too high"
);
assert(declined.kind === "QUOTE_DECLINED", `declined kind=${declined.kind}`);
assert(!declined.targetStatus, "plain decline must not change status");

const aacStill = detectUshipLifecycleEvent(
    "Your quote was declined",
    "THIS QUOTE WAS DECLINED\nDECLINE REASON\nAccepted another quote"
);
assert(aacStill.kind === "ACCEPTED_ANOTHER_COMPANY", `aac still kind=${aacStill.kind}`);

console.log("OK: Instant Alert / CTA does not false-trigger Bid Submitted");

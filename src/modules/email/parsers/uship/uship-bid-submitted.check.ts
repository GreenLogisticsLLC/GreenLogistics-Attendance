/**
 * Guards against false Bid Submitted on Instant Alerts / instructional CTAs.
 *   npx tsx src/modules/email/parsers/uship/uship-bid-submitted.check.ts
 */
import {
    detectUshipLifecycleEvent,
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

console.log("OK: Instant Alert / CTA does not false-trigger Bid Submitted");

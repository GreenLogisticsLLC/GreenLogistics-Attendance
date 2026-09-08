/**
 * AAC only when Decline Reason = Accepted another quote (broker Gmail body).
 *   npx tsx src/modules/email/parsers/uship/uship-aac-match.check.ts
 */
import { detectUshipLifecycleEvent } from "./uship-lifecycle.detector.js";

function assert(cond: unknown, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exit(1);
    }
}

const declineBody = `
THIS QUOTE WAS DECLINED, BUT THOUSANDS MORE SHIPMENTS ARE AVAILABLE
DECLINE REASON
Accepted another quote
Find Shipments
`;

const ok = detectUshipLifecycleEvent("Your quote was declined", declineBody);
assert(ok.kind === "ACCEPTED_ANOTHER_COMPANY", `decline reason kind=${ok.kind}`);
assert(ok.targetStatus === "ACCEPTED_ANOTHER_COMPANY", "targetStatus");

const htmlBody = `
<div>THIS QUOTE WAS DECLINED</div>
<p><span>DECLINE REASON</span></p>
<p><b>Accepted another quote</b></p>
`;
const html = detectUshipLifecycleEvent("Quote declined", htmlBody);
assert(html.kind === "ACCEPTED_ANOTHER_COMPANY", `html kind=${html.kind}`);

const loose = detectUshipLifecycleEvent(
    "Listing update",
    "This listing was booked by another company on uShip"
);
assert(loose.kind !== "ACCEPTED_ANOTHER_COMPANY", `loose kind=${loose.kind}`);

const otherReason = detectUshipLifecycleEvent(
    "Quote declined",
    "THIS QUOTE WAS DECLINED\nDECLINE REASON\nPrice too high"
);
assert(otherReason.kind !== "ACCEPTED_ANOTHER_COMPANY", `other reason kind=${otherReason.kind}`);

console.log("OK: AAC only on Decline Reason = Accepted another quote");

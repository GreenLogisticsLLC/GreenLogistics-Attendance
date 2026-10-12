/**
 * Guards against false Customer Replied on Instant Alerts / bare "new message".
 *   npx tsx src/modules/email/parsers/uship/uship-customer-replied.check.ts
 */
import {
  detectUshipLifecycleEvent,
  isNewListingAlertSubject,
} from "./uship-lifecycle.detector.js";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}

assert(
  isNewListingAlertSubject("INSTANT ALERT - Matches Your Green Saved Search"),
  "instant alert subject"
);
assert(
  isNewListingAlertSubject("New shipment - 1 Pallet - Matches Your Green Saved Search"),
  "new shipment subject"
);

const alertBody =
  "You have a new message waiting. Submit Quote Now. Matches Your Green Saved Search.";
const alert = detectUshipLifecycleEvent(
  "INSTANT ALERT - 1 Pallet - Matches Your Green Saved Search",
  alertBody
);
assert(alert.kind === "UNKNOWN", "instant alert kind=" + alert.kind);
assert(!alert.targetStatus, "instant alert must not set targetStatus");

const bareNewMessage = detectUshipLifecycleEvent(
  "uShip update",
  "You have a new message in your inbox. Visit uShip."
);
assert(
  bareNewMessage.kind === "UNKNOWN" || bareNewMessage.kind === "AGENT_WORKING",
  "bare new message must not be CUSTOMER_RESPOND, got " + bareNewMessage.kind
);
assert(
  bareNewMessage.targetStatus !== "CUSTOMER_REPLIED",
  "bare new message must not set CUSTOMER_REPLIED"
);

const realReply = detectUshipLifecycleEvent(
  "Question Answered - listing 123",
  "The customer has responded to your question on this shipment."
);
assert(realReply.kind === "CUSTOMER_RESPOND", "real reply kind=" + realReply.kind);
assert(realReply.targetStatus === "CUSTOMER_REPLIED", "real reply status");

const fromCustomer = detectUshipLifecycleEvent(
  "Message from customer",
  "You have a message from the customer about this listing."
);
assert(fromCustomer.kind === "CUSTOMER_RESPOND", "from customer kind=" + fromCustomer.kind);

console.log("OK: Instant Alert / bare new message does not false-trigger Customer Replied");

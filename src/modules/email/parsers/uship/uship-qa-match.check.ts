/**
 * Checks for Question Answered → Customer Respond detection + title hints.
 *   npx tsx src/modules/email/parsers/uship/uship-qa-match.check.ts
 */
import { customerAnswerExcerpt, detectUshipLifecycleEvent } from "./uship-lifecycle.detector.js";
import { titlesFromQuestionAnsweredEmail } from "./uship-qa-match.js";

function assert(cond: unknown, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exit(1);
    }
}

const subject = "Question Answered - 3 Pallets";
const body = `
A CUSTOMER HAS ANSWERED YOUR QUESTION
YOUR QUESTION are you ready to book?
ANSWER now
Submit Quote Now
SHIPMENT NAME 3 Pallets
PICKUP Los Angeles, California 90001
DELIVERY Crosslake, Minnesota 56442
`;

const detected = detectUshipLifecycleEvent(subject, body);
assert(detected.kind === "CUSTOMER_RESPOND", `kind=${detected.kind}`);
assert(detected.domainEventType === "CUSTOMER_RESPOND", "domainEventType");
assert(detected.targetStatus === "CUSTOMER_REPLIED", "targetStatus");

const titles = titlesFromQuestionAnsweredEmail(subject, body);
assert(titles.includes("3 pallets"), `titles=${JSON.stringify(titles)}`);

const longSubject = titlesFromQuestionAnsweredEmail(
    "Question Answered - 6 Pallets - A CUSTOMER HAS ANSWERED YOUR QUESTION",
    "SHIPMENT NAME 6 Pallets"
);
assert(longSubject.includes("6 pallets"), `long titles=${JSON.stringify(longSubject)}`);

const excerpt = customerAnswerExcerpt(subject, body);
assert(excerpt.includes("Answer: now"), `excerpt=${excerpt}`);
assert(excerpt.includes("Question: are you ready to book?"), `excerpt q=${excerpt}`);

const banner = detectUshipLifecycleEvent(
    "uShip notification",
    "A CUSTOMER HAS ANSWERED YOUR QUESTION\nYOUR QUESTION hello\nANSWER yes"
);
assert(banner.kind === "CUSTOMER_RESPOND", `banner kind=${banner.kind}`);

console.log("OK: Question Answered → CUSTOMER_RESPOND + title hints");

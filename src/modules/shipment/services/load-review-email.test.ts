import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewEmail } from "./load-review-email.service.js";

test("review email uses brand green and a larger Google feedback CTA", () => {
    const mail = buildReviewEmail({
        recipientKind: "customer",
        recipientName: "Nagapet",
        loadNumber: "GL10181",
    });
    assert.match(mail.subject, /GL10181/);
    assert.match(mail.html, /background:#059669/);
    assert.doesNotMatch(mail.html, /background:#16325c/);
    assert.match(mail.html, /Leave feedback on Google/);
    assert.match(mail.html, /googlelogo_color_92x30dp\.png/);
    assert.match(mail.html, /font-size:18px/);
});

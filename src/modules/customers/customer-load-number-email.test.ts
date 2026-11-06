import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerLoadNumberEmail } from "./customer-load-number-email.js";

test("welcome email includes the generated load number", () => {
    const mail = buildCustomerLoadNumberEmail({ loadNumber: "GL10088" });
    assert.match(mail.subject, /GL10088/);
    assert.match(mail.text, /Load Number: #GL10088/);
    assert.match(mail.html, /Load Number: #GL10088/);
    assert.match(mail.text, /Dear Valued Customer/);
    assert.match(mail.text, /Green Logistics LLC/);
});

test("empty load number still renders a placeholder line", () => {
    const mail = buildCustomerLoadNumberEmail({ loadNumber: "" });
    assert.match(mail.text, /Load Number: #—/);
});

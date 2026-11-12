import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomerInvoiceEmail } from "./customer-invoice-email.js";

test("customer invoice email mentions delivery, thanks, and payment", () => {
    const mail = buildCustomerInvoiceEmail({
        customerName: "Vukler Studio",
        loadNumber: "GL10043",
        invoiceNumber: "INV-10043",
        amountDue: 3200,
    });
    assert.match(mail.subject, /GL10043/);
    assert.match(mail.text, /successfully delivered/i);
    assert.match(mail.text, /Thank you for choosing Green Logistics/i);
    assert.match(mail.text, /process payment/i);
    assert.match(mail.text, /INV-10043/);
    assert.match(mail.html, /successfully delivered/i);
    assert.match(mail.html, /\$3,200\.00/);
    assert.match(mail.html, /background:#0b3d2e/);
    assert.doesNotMatch(mail.html, /background:#16325c/);
});

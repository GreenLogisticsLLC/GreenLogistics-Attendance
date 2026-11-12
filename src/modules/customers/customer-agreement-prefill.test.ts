import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMER_AGREEMENT_TYPES } from "./customer-agreement.js";
import {
    mergeAgreementFields,
    prefillCustomerAgreementFields,
} from "./customer-agreement-fields.js";

test("mergeAgreementFields keeps existing values and fills blanks", () => {
    const merged = mergeAgreementFields(
        { commodity: "Already set", totalWeight: "" },
        { commodity: "From load", totalWeight: "10000", equipment: "VAN" }
    );
    assert.equal(merged.commodity, "Already set");
    assert.equal(merged.totalWeight, "10000");
    assert.equal(merged.equipment, "VAN");
});

test("USHIP OneTime prefill copies load shipment and payment fields", () => {
    const fields = prefillCustomerAgreementFields({
        agreementType: CUSTOMER_AGREEMENT_TYPES.USHIP_ONETIME,
        companyName: "ashot",
        email: "aggreenlogistic@gmail.com",
        phone: "(267) 579-2793",
        timezone: "America/Los_Angeles",
        shipment: {
            loadNumber: "GL10142",
            greenOsShipmentId: "GOS1001129",
            commodity: "GDSFGFGDF",
            pieces: 5,
            weight: "10000",
            equipment: "VAN",
            pickupCity: "Los Angeles",
            pickupState: "CA",
            pickupZip: "90001",
            deliveryCity: "Los Angeles",
            deliveryState: "CA",
            deliveryZip: "90014",
            pickupFrom: new Date("2026-11-20T12:00:00Z"),
            deliveryFrom: new Date("2026-12-02T12:00:00Z"),
            customerRate: 500,
            customerPaymentLabel: "Zelle",
            specialInstructions: "Call before pickup",
        },
    });
    assert.equal(fields.companyName, "ashot");
    assert.equal(fields.email, "aggreenlogistic@gmail.com");
    assert.equal(fields.shipmentRef, "GL10142");
    assert.equal(fields.commodity, "GDSFGFGDF");
    assert.equal(fields.quantity, "5");
    assert.equal(fields.totalWeight, "10000");
    assert.equal(fields.equipment, "VAN");
    assert.match(fields.pickupAddress, /Los Angeles, CA 90001/);
    assert.match(fields.deliveryAddress, /Los Angeles, CA 90014/);
    assert.ok(fields.pickupDateTime);
    assert.ok(fields.deliveryDateTime);
    assert.equal(fields.totalCharge, "500");
    assert.equal(fields.firstPayment, "250");
    assert.equal(fields.finalPayment, "250");
    assert.equal(fields.paymentMethod, "Zelle");
    assert.equal(fields.additionalInstructions, "Call before pickup");
});

test("LONG_TIME prefill stays on customer identity fields", () => {
    const fields = prefillCustomerAgreementFields({
        agreementType: CUSTOMER_AGREEMENT_TYPES.LONG_TIME,
        companyName: "Acme LLC",
        contactName: "Alex",
        email: "alex@example.com",
        shipment: {
            loadNumber: "GL10142",
            commodity: "Should not appear on long-time form fields",
            customerRate: 500,
        },
    });
    assert.equal(fields.legalCompanyName, "Acme LLC");
    assert.equal(fields.authorizedRepresentative, "Alex");
    assert.equal(fields.email, "alex@example.com");
    assert.equal(fields.commodity, undefined);
});

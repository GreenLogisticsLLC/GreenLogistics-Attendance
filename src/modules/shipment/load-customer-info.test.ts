import assert from "node:assert/strict";
import test from "node:test";
import {
    buildLoadQuickActions,
    isCustomerInfoReady,
} from "./load-quick-actions.js";

test("customer info needs name plus email or phone", () => {
    assert.equal(isCustomerInfoReady({ customerName: "", customerEmail: "a@b.com" }), false);
    assert.equal(
        isCustomerInfoReady({ customerName: "TDA LLC", customerEmail: "a@b.com" }),
        true
    );
    assert.equal(
        isCustomerInfoReady({ customerName: "TDA LLC", customerPhone: "(555) 123-4567" }),
        true
    );
    assert.equal(
        isCustomerInfoReady({ customerName: "TDA LLC", customerEmail: "", customerPhone: "555" }),
        false
    );
});

test("Generate customer information is the first Create Load step after Booking", () => {
    const waiting = buildLoadQuickActions({
        status: "LOAD_CREATED",
        customerName: null,
        customerEmail: null,
        customerPhone: null,
        documents: [],
    });
    const customer = waiting.find((a) => a.id === "generate_customer");
    const assign = waiting.find((a) => a.id === "assign_carrier");
    assert.equal(customer?.state, "current");
    assert.equal(assign?.state, "locked");
    assert.match(String(assign?.blockedReason || ""), /customer information/i);

    const ready = buildLoadQuickActions({
        status: "LOAD_CREATED",
        customerName: "TDA LLC",
        customerEmail: "ops@tda.example",
        customerPhone: null,
        documents: [],
    });
    assert.equal(ready.find((a) => a.id === "generate_customer")?.state, "done");
    assert.equal(ready.find((a) => a.id === "assign_carrier")?.state, "current");
});

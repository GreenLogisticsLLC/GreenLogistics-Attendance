import assert from "node:assert/strict";
import test from "node:test";
import { isGeneratedLoad, isShipmentAssignmentKind } from "./shipment-tabs.js";

test("generated loads are Load Created or any shipment that already has a load number", () => {
    assert.equal(isGeneratedLoad({ status: "LOAD_CREATED", loadNumber: "GL100015" }), true);
    assert.equal(isGeneratedLoad({ status: "LOAD_CREATED", loadNumber: null }), true);
    assert.equal(isGeneratedLoad({ status: "CARRIER_ASSIGNED", loadNumber: "GL100012" }), true);
    assert.equal(isGeneratedLoad({ status: "IN_TRANSIT", loadNumber: "GL100002" }), true);
    assert.equal(isGeneratedLoad({ status: "WORKING", loadNumber: null }), false);
    assert.equal(isGeneratedLoad({ status: "ACCEPTED", loadNumber: "" }), false);
    assert.equal(isGeneratedLoad({ status: "ASSIGNED", loadNumber: null }), false);
    assert.equal(isGeneratedLoad({ status: "AWAITING_ACCEPTANCE", loadNumber: null }), false);
    assert.equal(isGeneratedLoad({ status: "DELETED_FROM_CUSTOMER", loadNumber: "GL100001" }), false);
    assert.equal(isGeneratedLoad({ status: "LOST", loadNumber: "GL100001" }), false);
    assert.equal(isGeneratedLoad({ status: "ACCEPTED_ANOTHER_COMPANY", loadNumber: "GL100001" }), false);
});

test("loads is a shipment tab kind", () => {
    assert.equal(isShipmentAssignmentKind("loads"), true);
    assert.equal(isShipmentAssignmentKind("other"), true);
    assert.equal(isShipmentAssignmentKind("customer"), false);
});

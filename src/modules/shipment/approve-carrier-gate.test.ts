import assert from "node:assert/strict";
import test from "node:test";
import {
    assertQuickActionAllowed,
    buildLoadQuickActions,
} from "./load-quick-actions.js";

test("runAction-style assert allows approve_carrier when customer fields are passed", () => {
    assert.doesNotThrow(() =>
        assertQuickActionAllowed("approve_carrier", {
            status: "CARRIER_ASSIGNED",
            carrierName: "TRANSLINK LOGISTICS INC",
            customerName: "Customer LLC",
            customerEmail: "ops@customer.example",
            loadCarrierApproved: false,
            documents: [],
        })
    );
});

test("runAction-style assert locks approve_carrier when customer fields are omitted", () => {
    // Missing customer* makes generate_customer the first open step, so Approve Carrier
    // stays locked (blockedReason: Assign Carrier first) even though a carrier is assigned.
    assert.throws(
        () =>
            assertQuickActionAllowed("approve_carrier", {
                status: "CARRIER_ASSIGNED",
                carrierName: "TRANSLINK LOGISTICS INC",
                loadCarrierApproved: false,
                documents: [],
            }),
        /Assign Carrier first|STEP_LOCKED|previous step/i
    );
});

test("after approve, generate_rate_con is current", () => {
    const actions = buildLoadQuickActions({
        status: "CARRIER_ASSIGNED",
        carrierName: "TRANSLINK LOGISTICS INC",
        customerName: "Customer LLC",
        customerEmail: "ops@customer.example",
        loadCarrierApproved: true,
        documents: [],
    });
    assert.equal(actions.find((a) => a.id === "generate_rate_con")?.state, "current");
});

import assert from "node:assert/strict";
import test from "node:test";
import { SHIPMENT_STATUSES } from "../shipment/shipment.constants.js";
import {
    SHIPMENT_STATUS_FILTERS,
    applyStatusGroupFilter,
    canonicalStatusGroup,
    shipmentStatusFilter,
    statusGroupIncludesDeleted,
    uncoveredShipmentStatuses,
} from "./shipment-status-filter.js";

test("status filter covers every shipment status once", () => {
    assert.deepEqual(uncoveredShipmentStatuses(), []);
    const seen = new Map<string, string>();
    for (const row of SHIPMENT_STATUS_FILTERS) {
        for (const status of row.statuses) {
            assert.equal(seen.has(status), false, status + " is in " + seen.get(status) + " and " + row.id);
            seen.set(status, row.id);
        }
    }
    for (const status of SHIPMENT_STATUSES) {
        assert.equal(seen.has(status), true, status);
    }
});

test("accepted, broker reply, and customer replied are separate filters", () => {
    assert.deepEqual(shipmentStatusFilter("WORKING"), ["WORKING"]);
    assert.deepEqual(shipmentStatusFilter("BROKER_REPLY"), ["BROKER_REPLY"]);
    assert.deepEqual(shipmentStatusFilter("CUSTOMER_REPLIED"), [
        "CUSTOMER_REPLIED",
        "CUSTOMER_RESPOND",
    ]);
    assert.equal(
        SHIPMENT_STATUS_FILTERS.find((row) => row.id === "WORKING")?.label,
        "Shipment Accepted"
    );
    assert.equal(
        SHIPMENT_STATUS_FILTERS.find((row) => row.id === "BROKER_REPLY")?.label,
        "BROKER REPLY"
    );
    assert.equal(
        SHIPMENT_STATUS_FILTERS.find((row) => row.id === "CUSTOMER_REPLIED")?.label,
        "Customer Replied"
    );
});

test("unknown filter is ignored and deleted filter keeps deleted rows", () => {
    assert.equal(canonicalStatusGroup("nope"), "");
    assert.equal(canonicalStatusGroup(""), "");
    assert.equal(shipmentStatusFilter("nope"), null);
    assert.equal(statusGroupIncludesDeleted("WORKING"), false);
    assert.equal(statusGroupIncludesDeleted("DELETED_FROM_CUSTOMER"), true);
    assert.equal(statusGroupIncludesDeleted(""), false);
});

test("status group is applied after a tab clears where.status", () => {
    const where: Record<string, unknown> = {
        status: "ACCEPTED_ANOTHER_COMPANY",
        AND: [{ status: { notIn: ["NEW", "AWAITING_ACCEPTANCE", "DELETED_FROM_CUSTOMER"] } }],
    };
    delete where.status;
    const applied = applyStatusGroupFilter(where, "BROKER_REPLY");
    assert.equal(applied, "BROKER_REPLY");
    assert.equal(where.status, undefined);
    assert.deepEqual(where.AND, [
        { status: { notIn: ["NEW", "AWAITING_ACCEPTANCE", "DELETED_FROM_CUSTOMER"] } },
        { status: { in: ["BROKER_REPLY"] } },
    ]);
    assert.equal(applyStatusGroupFilter(where, "not-a-status"), "");
});

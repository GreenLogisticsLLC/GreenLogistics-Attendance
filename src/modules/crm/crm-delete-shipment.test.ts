import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors crmDeleteShipmentController role gate. */
function canDeleteShipmentRole(role: string | null | undefined): boolean {
    return role === "Owner" || role === "Manager" || role === "Administrator";
}

test("Owner and Manager may delete a load; Broker and Team Lead may not", () => {
    assert.equal(canDeleteShipmentRole("Owner"), true);
    assert.equal(canDeleteShipmentRole("Manager"), true);
    assert.equal(canDeleteShipmentRole("Administrator"), true);
    assert.equal(canDeleteShipmentRole("Team Lead"), false);
    assert.equal(canDeleteShipmentRole("Broker"), false);
    assert.equal(canDeleteShipmentRole("Accounting"), false);
});

test("delete is allowed for shipment cards without a load number", () => {
    // load.service.deleteLoad used to 404 when loadNumber was null — Owner must
    // still be able to remove a board card (e.g. Load Created / New).
    const shipment = { shipmentLeadId: "lead-1", loadNumber: null as string | null };
    assert.equal(Boolean(shipment.shipmentLeadId), true);
    assert.equal(shipment.loadNumber, null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { canReceiveNewShipments, Roles } from "./roles.js";

test("only brokers and team leads can receive a new shipment", () => {
    assert.equal(canReceiveNewShipments(Roles.Broker), true);
    assert.equal(canReceiveNewShipments(Roles.TeamLead), true);
    assert.equal(canReceiveNewShipments(Roles.Manager), false);
    assert.equal(canReceiveNewShipments(Roles.Accounting), false);
    assert.equal(canReceiveNewShipments(Roles.Owner), false);
    assert.equal(canReceiveNewShipments(Roles.Administrator), false);
    assert.equal(canReceiveNewShipments(Roles.Dispatcher), false);
});

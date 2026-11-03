import assert from "node:assert/strict";
import test from "node:test";
import { canManageLoads, canReceiveNewShipments, Roles } from "./roles.js";

test("only brokers and team leads can receive a new shipment", () => {
    assert.equal(canReceiveNewShipments(Roles.Broker), true);
    assert.equal(canReceiveNewShipments(Roles.TeamLead), true);
    assert.equal(canReceiveNewShipments(Roles.Manager), false);
    assert.equal(canReceiveNewShipments(Roles.Accounting), false);
    assert.equal(canReceiveNewShipments(Roles.Owner), false);
    assert.equal(canReceiveNewShipments(Roles.Administrator), false);
    assert.equal(canReceiveNewShipments(Roles.Dispatcher), false);
});

test("team lead, manager, owner, and accounting can change or delete a load", () => {
    assert.equal(canManageLoads(Roles.TeamLead), true);
    assert.equal(canManageLoads(Roles.Manager), true);
    assert.equal(canManageLoads(Roles.Owner), true);
    assert.equal(canManageLoads(Roles.Accounting), true);
    assert.equal(canManageLoads(Roles.Broker), false);
    assert.equal(canManageLoads(Roles.Administrator), false);
});

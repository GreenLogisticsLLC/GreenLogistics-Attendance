import assert from "node:assert/strict";
import test from "node:test";
import { carrierMissingOnPickup, carrierMissingRecipients } from "./carrier-missing-on-pickup.js";

const TZ = "America/Los_Angeles";

test("pickup day with no carrier is flagged in company time", () => {
    const pickup = new Date("2026-11-06T16:00:00.000Z");
    assert.equal(
        carrierMissingOnPickup({
            loadNumber: "GL100017",
            carrierName: null,
            status: "LOAD_CREATED",
            pickupFrom: pickup,
            now: new Date("2026-11-06T16:30:00.000Z"),
            timeZone: TZ,
        }),
        true
    );
    assert.equal(
        carrierMissingOnPickup({
            loadNumber: "GL100017",
            carrierName: "  ",
            status: "DISPATCH",
            pickupFrom: pickup,
            now: new Date("2026-11-07T18:00:00.000Z"),
            timeZone: TZ,
        }),
        true
    );
    assert.equal(
        carrierMissingOnPickup({
            loadNumber: "GL100017",
            carrierName: null,
            pickupFrom: pickup,
            now: new Date("2026-11-06T07:30:00.000Z"),
            timeZone: TZ,
        }),
        false
    );
    assert.equal(
        carrierMissingOnPickup({
            loadNumber: "GL100017",
            carrierName: "Amigos Transport",
            pickupFrom: pickup,
            now: new Date("2026-11-06T20:00:00.000Z"),
            timeZone: TZ,
        }),
        false
    );
    assert.equal(
        carrierMissingOnPickup({
            loadNumber: null,
            carrierName: null,
            pickupFrom: pickup,
            now: new Date("2026-11-06T20:00:00.000Z"),
            timeZone: TZ,
        }),
        false
    );
    assert.equal(
        carrierMissingOnPickup({
            loadNumber: "GL100017",
            carrierName: null,
            status: "CLOSED",
            pickupFrom: pickup,
            now: new Date("2026-11-06T20:00:00.000Z"),
            timeZone: TZ,
        }),
        false
    );
});

test("alert goes to the broker team lead and managers", () => {
    assert.deepEqual(
        carrierMissingRecipients({
            brokerUserId: "broker-1",
            brokerRole: "Broker",
            brokerTeamLeadId: "lead-1",
            managerUserIds: ["mgr-1", "mgr-2"],
        }).sort(),
        ["lead-1", "mgr-1", "mgr-2"]
    );
    assert.deepEqual(
        carrierMissingRecipients({
            brokerUserId: "lead-2",
            brokerRole: "Team Lead",
            brokerTeamLeadId: null,
            managerUserIds: ["mgr-1"],
        }).sort(),
        ["lead-2", "mgr-1"]
    );
});

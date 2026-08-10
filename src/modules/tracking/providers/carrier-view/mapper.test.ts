/**
 * CarrierView unit tests (mocked HTTP — never calls production).
 * Run: npx tsx --test src/modules/tracking/providers/carrier-view/*.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    fingerprintPosition,
    normalizeCarrierViewLoad,
    normalizeCarrierViewPosition,
    toCarrierViewCreateBody,
    toCarrierViewPatchBody,
} from "./mapper.js";
import {
    CarrierViewRateLimited,
    mapCarrierViewError,
    CarrierViewLoadNotFound,
    CarrierViewValidationError,
    CarrierViewDriverOptedOut,
} from "./errors.js";

describe("CarrierView error mapping", () => {
    it("maps known error codes", () => {
        assert.ok(mapCarrierViewError("load_not_found") instanceof CarrierViewLoadNotFound);
        assert.ok(mapCarrierViewError("required_fields_errors") instanceof CarrierViewValidationError);
        assert.ok(mapCarrierViewError("driver_opted_out") instanceof CarrierViewDriverOptedOut);
    });

    it("maps HTTP 429", () => {
        const err = mapCarrierViewError("rate_limited", {}, 429);
        assert.ok(err instanceof CarrierViewRateLimited || err.code === "rate_limited");
    });
});

describe("CarrierView mapper", () => {
    it("builds create body with pickup + destination", () => {
        const body = toCarrierViewCreateBody({
            driverPhone: "+15551234567",
            externalLoadRef: "GL100001",
            locations: [
                {
                    address: "North East, MD",
                    company: "A",
                    type: "pickup",
                    dateFrom: "2024-02-10 10:00",
                    dateTo: "2024-02-11 11:00",
                },
                {
                    address: "Yerington, NV",
                    company: "B",
                    type: "destination",
                    dateFrom: "2024-02-20 10:00",
                    dateTo: "2024-02-21 11:00",
                },
            ],
        });
        assert.equal(body.integration_type, "carrier_view");
        assert.equal(body.driver_phone, "+15551234567");
        assert.equal(body.load_id, "GL100001");
        assert.equal(body.locations.length, 2);
        assert.equal(body.locations[0].type, "pickup");
        assert.equal(body.locations[1].type, "destination");
        assert.equal(body.locations[0].dateFrom, "2024-02-10 10:00");
    });

    it("omits empty location dates from create body", () => {
        const body = toCarrierViewCreateBody({
            driverPhone: "+15551234567",
            externalLoadRef: "GL100002",
            locations: [
                { address: "A, TX", company: "A", type: "pickup" },
                { address: "B, NV", company: "B", type: "destination", dateFrom: "2026-08-11 10:00" },
            ],
        });
        assert.equal("dateFrom" in body.locations[0], false);
        assert.equal("dateTo" in body.locations[0], false);
        assert.equal(body.locations[1].dateFrom, "2026-08-11 10:00");
    });

    it("omits emails/dispatchers from PATCH unless include flags set", () => {
        const empty = toCarrierViewPatchBody({
            includeEmails: false,
            includeDispatchers: false,
            includeLocations: false,
        });
        assert.equal(Object.keys(empty).length, 0);

        const withEmails = toCarrierViewPatchBody({
            emails: ["a@b.com"],
            includeEmails: true,
            includeDispatchers: false,
            includeLocations: false,
        });
        assert.deepEqual(withEmails.emails, ["a@b.com"]);
        assert.equal("dispatchers" in withEmails, false);
    });

    it("normalizes last position", () => {
        const pos = normalizeCarrierViewPosition(
            {
                driver_phone: "+1",
                type: "moving",
                latitude: 40.1,
                longitude: -74.2,
                address: "NY",
                late_secs: 12,
                rotation: 90,
            },
            { shipmentId: "s1", providerLoadId: "529" }
        );
        assert.ok(pos);
        assert.equal(pos!.provider, "carrier_view");
        assert.equal(pos!.latitude, 40.1);
        assert.equal(pos!.providerLoadId, "529");
        assert.equal(pos!.lateSeconds, 12);
    });

    it("normalizes load and stores CarrierView id", () => {
        const load = normalizeCarrierViewLoad({
            id: 529,
            load_id: "GL100001",
            driver_phone: "+1555",
            tracking_number_url: "https://track.example/1",
            client_url: "https://client.example/1",
            route_started: true,
            driver_is_late: false,
            time_left_sec: 3600,
            distance_left_meters: 50000,
        });
        assert.equal(load.providerLoadId, "529");
        assert.equal(load.externalLoadRef, "GL100001");
        assert.equal(load.trackingUrl, "https://track.example/1");
        assert.equal(load.routeStarted, true);
    });

    it("fingerprints positions for dedupe", () => {
        const a = fingerprintPosition({
            providerLoadId: "1",
            latitude: 1.1234567,
            longitude: 2.1234567,
            timestamp: "t",
        });
        const b = fingerprintPosition({
            providerLoadId: "1",
            latitude: 1.1234567,
            longitude: 2.1234567,
            timestamp: "t",
        });
        const c = fingerprintPosition({
            providerLoadId: "1",
            latitude: 9,
            longitude: 2.1234567,
            timestamp: "t",
        });
        assert.equal(a, b);
        assert.notEqual(a, c);
    });
});

describe("CarrierView client auth header contract", () => {
    it("documents Bearer requirement without leaking token", () => {
        // Structural: createLoad body never includes Authorization.
        const body = toCarrierViewCreateBody({
            driverPhone: "+1",
            externalLoadRef: "GL1",
            locations: [
                { address: "a", type: "pickup" },
                { address: "b", type: "destination" },
            ],
        });
        assert.equal("Authorization" in body, false);
        assert.equal("token" in body, false);
    });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
    computeCarrierSuperseded,
    isNameAndEmailCarrierChange,
    isSameCarrierIdentity,
    normMc,
} from "./carrier-superseded.js";

test("isSameCarrierIdentity requires matching email+name+mc", () => {
    assert.equal(
        isSameCarrierIdentity(
            { email: "a@x.com", legalName: "Kamo", mcNumber: "MC1237784" },
            { email: "a@x.com", legalName: "kamo", mcNumber: "1237784" }
        ),
        true
    );
    assert.equal(
        isSameCarrierIdentity(
            { email: "a@x.com", legalName: "Derek", mcNumber: "1237784" },
            { email: "a@x.com", legalName: "kamo", mcNumber: "1237784" }
        ),
        false
    );
    assert.equal(
        isSameCarrierIdentity(
            { email: "derek@x.com", legalName: "Derek", mcNumber: "1237784" },
            { email: "a@x.com", legalName: "Derek", mcNumber: "1237784" }
        ),
        false
    );
});

test("isNameAndEmailCarrierChange requires both name and email to differ", () => {
    assert.equal(
        isNameAndEmailCarrierChange(
            { name: "Old Carrier LLC", email: "old@x.com" },
            { name: "New Carrier LLC", email: "new@x.com" }
        ),
        true
    );
    assert.equal(
        isNameAndEmailCarrierChange(
            { name: "Same Name", email: "old@x.com" },
            { name: "Same Name", email: "new@x.com" }
        ),
        false
    );
    assert.equal(
        isNameAndEmailCarrierChange(
            { name: "Old Carrier", email: "same@x.com" },
            { name: "New Carrier", email: "same@x.com" }
        ),
        false
    );
    assert.equal(
        isNameAndEmailCarrierChange(
            { name: "", email: "old@x.com" },
            { name: "New", email: "new@x.com" }
        ),
        false
    );
});

test("computeCarrierSuperseded: official load carrier is never red", () => {
    const r = computeCarrierSuperseded({
        carrierId: "kamo",
        createdAt: "2026-09-08T12:00:00Z",
        mcNumber: "1237784",
        officialOnLoadIds: ["load1"],
        linkedLoadIds: ["load1"],
        officialByLoad: { load1: "kamo" },
        mcPeers: [
            { carrierId: "gl", createdAt: "2026-09-01T12:00:00Z", isOfficialOnAnyLoad: false },
            { carrierId: "kamo", createdAt: "2026-09-08T12:00:00Z", isOfficialOnAnyLoad: true },
        ],
    });
    assert.equal(r.isSuperseded, false);
    assert.equal(r.isOfficialLoadCarrier, true);
});

test("computeCarrierSuperseded: previous registration on same load is red", () => {
    const r = computeCarrierSuperseded({
        carrierId: "derek",
        createdAt: "2026-09-05T12:00:00Z",
        mcNumber: "1237784",
        officialOnLoadIds: [],
        linkedLoadIds: ["load1"],
        officialByLoad: { load1: "kamo" },
        mcPeers: [
            { carrierId: "derek", createdAt: "2026-09-05T12:00:00Z", isOfficialOnAnyLoad: false },
            { carrierId: "kamo", createdAt: "2026-09-08T12:00:00Z", isOfficialOnAnyLoad: true },
        ],
    });
    assert.equal(r.isSuperseded, true);
    assert.equal(r.reason, "replaced_on_load");
});

test("computeCarrierSuperseded: older same-MC registration is red even before load link", () => {
    const r = computeCarrierSuperseded({
        carrierId: "gl",
        createdAt: "2026-09-01T12:00:00Z",
        mcNumber: "1237784",
        officialOnLoadIds: [],
        linkedLoadIds: [],
        officialByLoad: {},
        mcPeers: [
            { carrierId: "gl", createdAt: "2026-09-01T12:00:00Z", isOfficialOnAnyLoad: false },
            { carrierId: "derek", createdAt: "2026-09-05T12:00:00Z", isOfficialOnAnyLoad: false },
            { carrierId: "kamo", createdAt: "2026-09-08T12:00:00Z", isOfficialOnAnyLoad: false },
        ],
    });
    assert.equal(r.isSuperseded, true);
    assert.equal(r.reason, "older_registration");
});

test("computeCarrierSuperseded: newest same-MC registration stays normal", () => {
    const r = computeCarrierSuperseded({
        carrierId: "kamo",
        createdAt: "2026-09-08T12:00:00Z",
        mcNumber: "1237784",
        officialOnLoadIds: [],
        linkedLoadIds: [],
        officialByLoad: {},
        mcPeers: [
            { carrierId: "gl", createdAt: "2026-09-01T12:00:00Z", isOfficialOnAnyLoad: false },
            { carrierId: "kamo", createdAt: "2026-09-08T12:00:00Z", isOfficialOnAnyLoad: false },
        ],
    });
    assert.equal(r.isSuperseded, false);
});

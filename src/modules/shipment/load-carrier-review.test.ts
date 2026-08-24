import assert from "node:assert/strict";
import test from "node:test";
import {
    buildCarrierReviewSlots,
    isLoadCarrierApproved,
} from "./load-carrier-review.js";
import { buildLoadQuickActions } from "./load-quick-actions.js";

test("reference packet builds review slots without attaching load docs", () => {
    const slots = buildCarrierReviewSlots({
        packetDocs: [
            { documentId: "mc1", documentType: "MC_AUTHORITY", originalFilename: "mc.pdf" },
            { documentId: "w91", documentType: "W9", originalFilename: "w9.pdf" },
            { documentId: "coi1", documentType: "COI", originalFilename: "coi.pdf" },
            {
                documentId: "agr1",
                documentType: "BROKER_CARRIER_AGREEMENT",
                originalFilename: "agr.pdf",
            },
        ],
        priorLoadDocs: [
            {
                documentId: "rc-old",
                documentType: "RATE_CONFIRMATION",
                originalFilename: "rc.pdf",
                sourceLoadNumber: "GL100001",
            },
            {
                documentId: "bol-old",
                documentType: "BOL",
                originalFilename: "bol.pdf",
                sourceLoadNumber: "GL100001",
            },
        ],
    });
    assert.equal(slots.length, 6);
    assert.equal(slots.every((s) => s.present), true);
    assert.equal(slots.find((s) => s.key === "COI")?.label, "Certificate of Holder");
    assert.equal(slots.find((s) => s.key === "RATE_CONFIRMATION")?.source, "prior_load");
});

test("global onboarding APPROVED is not enough for Rate Con", () => {
    const actions = buildLoadQuickActions({
        status: "CARRIER_ASSIGNED",
        carrierName: "Ash",
        loadCarrierApproved: false,
        documents: [],
    });
    assert.equal(actions.find((a) => a.id === "approve_carrier")?.state, "current");
    assert.equal(actions.find((a) => a.id === "generate_rate_con")?.state, "locked");
});

test("Approved Carrier unlocks Generate Rate Confirmation", () => {
    const actions = buildLoadQuickActions({
        status: "CARRIER_ASSIGNED",
        carrierName: "Ash",
        loadCarrierApproved: true,
        documents: [],
    });
    assert.equal(actions.find((a) => a.id === "approve_carrier")?.state, "done");
    assert.equal(actions.find((a) => a.id === "generate_rate_con")?.state, "current");
});

test("isLoadCarrierApproved requires matching profile id", () => {
    assert.equal(
        isLoadCarrierApproved({
            carrierProfileId: "c1",
            loadCarrierApprovedAt: new Date(),
            loadCarrierApprovedProfileId: "c1",
        }),
        true
    );
    assert.equal(
        isLoadCarrierApproved({
            carrierProfileId: "c1",
            loadCarrierApprovedAt: new Date(),
            loadCarrierApprovedProfileId: "other",
        }),
        false
    );
});

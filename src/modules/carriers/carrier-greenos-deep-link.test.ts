import assert from "node:assert/strict";
import test from "node:test";
import { CarrierEmailService } from "./services/carrier-email.service.js";

test("loadRecordUrl deep-links to shipmentLeadId + documents tab", () => {
    const svc = new CarrierEmailService();
    const url = svc.loadRecordUrl("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
        tab: "documents",
        loadNumber: "GL10142",
    });
    assert.match(url, /shipmentLeadId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
    assert.match(url, /tab=documents/);
    assert.match(url, /loadNumber=GL10142/);
});

test("carrierRecordUrl includes carriers hash route", () => {
    const svc = new CarrierEmailService();
    const url = svc.carrierRecordUrl("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.match(url, /carrierId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
    assert.match(url, /#\/carriers\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
});

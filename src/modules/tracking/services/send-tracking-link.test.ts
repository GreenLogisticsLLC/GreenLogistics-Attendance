import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackingService } from "./tracking.service.js";

describe("sendTrackingLink", () => {
    it("rejects a carrier number that is not a US phone before any tracking call", async () => {
        await assert.rejects(
            () =>
                trackingService.sendTrackingLink({
                    shipmentLeadId: "not-a-real-load",
                    driverPhone: "123",
                }),
            (err: unknown) => {
                const e = err as { status?: number; message?: string };
                assert.equal(e.status, 422);
                assert.match(String(e.message), /Carrier number/);
                return true;
            }
        );
    });
});

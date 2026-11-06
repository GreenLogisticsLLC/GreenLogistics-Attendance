import assert from "node:assert/strict";
import test from "node:test";
import { presenceSessionIsInOffice } from "./attendance-presence.service.js";

test("Live Board INSIDE_OFFICE counts as in office for the assignment queue", () => {
    assert.equal(presenceSessionIsInOffice({ currentStatus: "INSIDE_OFFICE" }), true);
});

test("Out of Office and scheduled rows are not in the shipment queue", () => {
    assert.equal(presenceSessionIsInOffice({ currentStatus: "OUTSIDE_OFFICE" }), false);
    assert.equal(presenceSessionIsInOffice({ currentStatus: "SCHEDULED" }), false);
    assert.equal(presenceSessionIsInOffice({ currentStatus: "COMPLETED" }), false);
    assert.equal(presenceSessionIsInOffice(null), false);
    assert.equal(presenceSessionIsInOffice(undefined), false);
});

test("carry-over overnight INSIDE still counts — no stale lastActivity gate", () => {
    // Previously getInOfficeEmployeeIds dropped INSIDE after scheduledEnd+2h unless
    // door lastActivity was <12h old. GreenOS clicks do not refresh lastActivity, so
    // a Team Lead still In Office on the board (e.g. Alen Young) was listed as
    // "Not in office" during the Yerevan evening shift.
    assert.equal(
        presenceSessionIsInOffice({
            currentStatus: "INSIDE_OFFICE",
        }),
        true
    );
});

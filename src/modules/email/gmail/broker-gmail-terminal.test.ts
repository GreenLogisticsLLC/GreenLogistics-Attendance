import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    BROKER_GMAIL_TERMINAL_METHODS,
    isBrokerGmailTerminalMethod,
} from "./broker-gmail-classify.js";
import { isNewListingAlertSubject } from "../parsers/uship/uship-lifecycle.detector.js";
import { isPermanentGmailMissingError } from "../../../utils/runtime-log.js";

describe("broker gmail terminal classification", () => {
    it("treats saved-search subjects as Instant Alert / new listing", () => {
        assert.equal(
            isNewListingAlertSubject(
                "New shipment - Pj-Trailer Goosebeck - Matches Your Bob Saved Search"
            ),
            true
        );
        assert.equal(
            isNewListingAlertSubject(
                "New shipment - Pj-Trailer Gooseletter - Matches Your ALL Saved Search"
            ),
            true
        );
        assert.equal(isNewListingAlertSubject("Quote Confirmation - 4 Pallets"), false);
    });

    it("marks SAVED_SEARCH_ALERT and GMAIL_NOT_FOUND as terminal", () => {
        assert.deepEqual([...BROKER_GMAIL_TERMINAL_METHODS], [
            "SAVED_SEARCH_ALERT",
            "GMAIL_NOT_FOUND",
        ]);
        assert.equal(isBrokerGmailTerminalMethod("SAVED_SEARCH_ALERT"), true);
        assert.equal(isBrokerGmailTerminalMethod("GMAIL_NOT_FOUND"), true);
        assert.equal(isBrokerGmailTerminalMethod("THREAD"), false);
    });

    it("detects permanent Gmail 404", () => {
        assert.equal(
            isPermanentGmailMissingError(
                Object.assign(new Error("Requested entity was not found."), { code: 404 })
            ),
            true
        );
        assert.equal(isPermanentGmailMissingError(new Error("rate limit exceeded")), false);
    });
});

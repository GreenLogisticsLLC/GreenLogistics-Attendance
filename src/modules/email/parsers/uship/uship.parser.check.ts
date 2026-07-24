import { ushipParser } from "./uship.parser.js";
import type { RawEmailMessage } from "../../models/types.js";

const sample: RawEmailMessage = {
    gmailMessageId: "msg-test-1",
    fromAddress: "uShip <no-reply@email.uship.com>",
    subject: "New shipment - Seagrave 1927 fire truck - Matches Your Green Saved Search",
    receivedAt: new Date("2026-07-24T10:00:00Z"),
    bodyText: `
Pickup: Los Angeles, CA 90001
Delivery: Phoenix, AZ 85001
Distance: 372 miles
Category: Vehicles
https://www.uship.com/listing/12345678
`,
};

if (!ushipParser.canParse(sample)) {
    console.error("FAIL: canParse expected true");
    process.exit(1);
}

const draft = ushipParser.parse(sample);
if (!draft || draft.source !== "USHIP" || !draft.shipmentTitle.includes("Seagrave")) {
    console.error("FAIL: parse title", draft);
    process.exit(1);
}
if (draft.pickupCity !== "Los Angeles" || draft.deliveryCity !== "Phoenix") {
    console.error("FAIL: parse cities", draft);
    process.exit(1);
}
if (!draft.viewUrl?.includes("uship.com")) {
    console.error("FAIL: viewUrl", draft);
    process.exit(1);
}

console.log("OK: uShip parser unit check passed");

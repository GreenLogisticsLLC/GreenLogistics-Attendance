import { ushipParser } from "./uship.parser.js";
import type { RawEmailMessage } from "../../models/types.js";

const classic: RawEmailMessage = {
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

if (!ushipParser.canParse(classic)) {
    console.error("FAIL: canParse classic expected true");
    process.exit(1);
}

const classicDraft = ushipParser.parse(classic);
if (!classicDraft || classicDraft.source !== "USHIP" || !classicDraft.shipmentTitle.includes("Seagrave")) {
    console.error("FAIL: parse classic title", classicDraft);
    process.exit(1);
}
if (classicDraft.pickupCity !== "Los Angeles" || classicDraft.deliveryCity !== "Phoenix") {
    console.error("FAIL: parse classic cities", classicDraft);
    process.exit(1);
}
if (classicDraft.miles !== 372) {
    console.error("FAIL: classic miles", classicDraft.miles);
    process.exit(1);
}
if (!classicDraft.viewUrl?.includes("uship.com")) {
    console.error("FAIL: viewUrl", classicDraft);
    process.exit(1);
}

const instant: RawEmailMessage = {
    gmailMessageId: "msg-instant-1",
    fromAddress: "uShip <no-reply@email.uship.com>",
    subject: "INSTANT ALERT - Matches Your Green Saved Search",
    receivedAt: new Date("2026-08-06T10:00:00Z"),
    bodyText: `
INSTANT ALERT
SAVED SEARCH: Green
Fairmont, MN 56031
8/6/2026 – 8/10/2026
Covington, WA 98042
8/12/2026 – 8/26/2026
1645 mi
2 Pallets
LTL Freight: New Commercial Goods
View https://www.uship.com/listing/99887766
`,
    bodyHtml: `
<div>INSTANT ALERT</div>
<div>SAVED SEARCH: Green</div>
<img src="https://cdn.uship.com/photos/pallets.jpg"/>
<a href="https://www.uship.com/listing/99887766">View</a>
`,
};

if (!ushipParser.canParse(instant)) {
    console.error("FAIL: canParse Instant Alert expected true");
    process.exit(1);
}

const instantDraft = ushipParser.parse(instant);
if (!instantDraft) {
    console.error("FAIL: Instant Alert parse returned null");
    process.exit(1);
}
if (instantDraft.pickupCity !== "Fairmont" || instantDraft.pickupState !== "MN" || instantDraft.pickupZip !== "56031") {
    console.error("FAIL: Instant Alert pickup", instantDraft);
    process.exit(1);
}
if (
    instantDraft.deliveryCity !== "Covington" ||
    instantDraft.deliveryState !== "WA" ||
    instantDraft.deliveryZip !== "98042"
) {
    console.error("FAIL: Instant Alert delivery", instantDraft);
    process.exit(1);
}
if (instantDraft.miles !== 1645) {
    console.error("FAIL: Instant Alert miles", instantDraft.miles);
    process.exit(1);
}
if (!instantDraft.vehicle || !/2 Pallets/i.test(instantDraft.vehicle)) {
    console.error("FAIL: Instant Alert vehicle", instantDraft.vehicle);
    process.exit(1);
}
if (!instantDraft.category || !/New Commercial Goods/i.test(instantDraft.category)) {
    console.error("FAIL: Instant Alert category", instantDraft.category);
    process.exit(1);
}
if (!instantDraft.equipment || !/LTL/i.test(instantDraft.equipment)) {
    console.error("FAIL: Instant Alert equipment", instantDraft.equipment);
    process.exit(1);
}
if (!instantDraft.pickupFrom || !instantDraft.deliveryFrom) {
    console.error("FAIL: Instant Alert dates", {
        pickupFrom: instantDraft.pickupFrom,
        deliveryFrom: instantDraft.deliveryFrom,
    });
    process.exit(1);
}
if (instantDraft.externalShipmentId !== "99887766") {
    console.error("FAIL: Instant Alert external id", instantDraft.externalShipmentId);
    process.exit(1);
}
if (!instantDraft.imageUrl) {
    console.error("FAIL: Instant Alert imageUrl", instantDraft.imageUrl);
    process.exit(1);
}

const encoded: RawEmailMessage = {
    gmailMessageId: "msg-encoded-1",
    fromAddress: "uShip <no-reply@email.uship.com>",
    subject: "INSTANT ALERT - Matches Your Green Saved Search",
    receivedAt: new Date("2026-09-03T10:00:00Z"),
    bodyText: "View listing",
    bodyHtml: `href=3D"https://www.uship.com/listing/=\n55443322" src="https://cdn.uship.com/photos/pallets.jpg"`,
};

const encodedDraft = ushipParser.parse(encoded);
if (encodedDraft?.externalShipmentId !== "55443322" || !encodedDraft.viewUrl?.includes("55443322")) {
    console.error("FAIL: encoded / quoted-printable listing URL", encodedDraft);
    process.exit(1);
}

const tracked: RawEmailMessage = {
    gmailMessageId: "msg-track-1",
    fromAddress: "uShip <no-reply@email.uship.com>",
    subject: "INSTANT ALERT - Matches Your Green Saved Search",
    receivedAt: new Date("2026-09-03T11:00:00Z"),
    bodyText: "View listing",
    bodyHtml: `<a href="https://click.mail.uship.com/ls/click?url=https%3A%2F%2Fwww.uship.com%2Flisting%2F66778899">View</a>`,
};
const trackedDraft = ushipParser.parse(tracked);
if (trackedDraft?.externalShipmentId !== "66778899") {
    console.error("FAIL: tracking url= listing id", trackedDraft);
    process.exit(1);
}

console.log("OK: uShip parser unit check passed (classic + Instant Alert)");
console.log(
    JSON.stringify(
        {
            classic: {
                title: classicDraft.shipmentTitle,
                miles: classicDraft.miles,
                category: classicDraft.category,
            },
            instant: {
                title: instantDraft.shipmentTitle,
                route: `${instantDraft.pickupCity} → ${instantDraft.deliveryCity}`,
                miles: instantDraft.miles,
                vehicle: instantDraft.vehicle,
                category: instantDraft.category,
                equipment: instantDraft.equipment,
            },
        },
        null,
        2
    )
);

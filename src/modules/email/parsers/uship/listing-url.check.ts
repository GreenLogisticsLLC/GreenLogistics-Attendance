import {
    canonicalUshipListingUrl,
    cleanResolvedUshipUrl,
    listingIdFromText,
    listingIdsFromText,
    trackingUrlsFromText,
    ushipListingUrlFromLead,
} from "./listing-url.js";

function assert(cond: unknown, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exit(1);
    }
}

assert(listingIdFromText("Pickup: Los Angeles, CA 90001") === null, "zip is not a listing id");
assert(
    listingIdFromText("https://click.mail.uship.com/ls/click?url=https%3A%2F%2Fwww.uship.com%2Flisting%2F66778899%2FFire-Truck") ===
        "66778899",
    "tracking url= listing id"
);
assert(
    listingIdFromText('href=3D"https://www.uship.com/listing/=\n55443322/Title"') === "55443322",
    "quoted-printable listing id"
);
assert(
    canonicalUshipListingUrl("710571686", "2001 Volkswagen Cabrio") ===
        "https://www.uship.com/listing/710571686/2001-Volkswagen-Cabrio/",
    "canonical with slug"
);

const fromLead = ushipListingUrlFromLead(
    {
        viewUrl: "https://click.mail.uship.com/ls/click?upn=expired",
        shipmentTitle: "2009 Buell Blast",
        pickupZip: "28105",
    },
    ["View https://www.uship.com/listing/914816914/2009-Buell-Blast/"]
);
assert(
    fromLead === "https://www.uship.com/listing/914816914/2009-Buell-Blast/",
    "lead prefers real listing URL over tracking viewUrl: " + fromLead
);

assert(
    listingIdsFromText("shipment 15000 miles from 90001").length === 0,
    "miles/zip must not become listing ids"
);

const sticky = ushipListingUrlFromLead(
    {
        externalShipmentId: "914816914",
        shipmentTitle: "2009 Buell Blast",
        viewUrl: "",
    },
    [
        "https://www.uship.com/listing/914816914/2009-Buell-Blast/",
        "Later email https://www.uship.com/listing/111222333/Other-Load/",
    ]
);
assert(
    sticky === "https://www.uship.com/listing/914816914/2009-Buell-Blast/",
    "card listing number stays sticky: " + sticky
);

const noFakeSlug = ushipListingUrlFromLead(
    {
        externalShipmentId: "914816914",
        shipmentTitle: "2009 Buell Blast",
        viewUrl: "",
    },
    ["Later email https://www.uship.com/listing/111222333/Other-Load/"]
);
assert(noFakeSlug === null, "do not invent a slug from our title: " + noFakeSlug);

assert(
    listingIdFromText("https://www.uship.com/shipment/3-Pallets/470376850/") === "470376850",
    "shipment/{slug}/{id} format"
);
assert(
    cleanResolvedUshipUrl("https://www.uship.com/listing/12345678") ===
        "https://www.uship.com/listing/12345678/",
    "bare listing url without invented slug"
);
assert(
    cleanResolvedUshipUrl(
        "https://www.uship.com/shipment/3-Pallets/470376850/?utm_medium=Email"
    ) === "https://www.uship.com/shipment/3-Pallets/470376850/",
    "clean shipment url"
);
assert(
    trackingUrlsFromText(
        'href="https://track.uship.com/f/a/abc~~/AA~/payload"'
    )[0]?.includes("track.uship.com"),
    "track.uship.com is a tracker"
);

console.log("OK: listing-url checks passed");

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
    generateLoadDocumentPdf,
    LOAD_DOCS_ROOT,
} from "./services/load-pdf.service.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;

test("Rate Con form markup includes PICKUP NOTE before Final destination", () => {
    const pages = fs.readFileSync(
        path.join(process.cwd(), "frontend/public/modules/dispatch/pages.js"),
        "utf8"
    );
    const contact = pages.indexOf('Pickup contact <input id="rc-pcontact"');
    const note = pages.indexOf('PICKUP NOTE <textarea id="rc-pickup-note"');
    const dest = pages.indexOf("Final destination *");
    assert.ok(contact > 0);
    assert.ok(note > contact);
    assert.ok(dest > note);
    assert.match(pages, /pickupNote:\s*box\.querySelector\("#rc-pickup-note"\)\.value/);
});

test("Rate Con PDF includes PICKUP NOTE text from content", async () => {
    const shipmentLeadId = `pickup-note-test-${Date.now()}`;
    const note = "Gate code 4455 — dock B";
    const out = await generateLoadDocumentPdf({
        shipmentLeadId,
        docType: "RATE_CONFIRMATION",
        version: 1,
        content: {
            loadNumber: "GL-TEST-NOTE",
            pickupAddress: "Woodcliff Lake, NJ, 07677",
            deliveryAddress: "Cumming, GA, 30040",
            pickupContact: "Shipper desk",
            pickupNote: note,
            flatRate: 2000,
            carrierRate: 2000,
            weight: "12000",
            commodity: "Isuzu",
        },
    });

    const abs = path.join(LOAD_DOCS_ROOT, shipmentLeadId, out.storedName);
    assert.equal(fs.existsSync(abs), true);
    const parsed = await pdfParse(fs.readFileSync(abs));
    assert.match(parsed.text, /PICKUP NOTE/i);
    assert.match(parsed.text, /Gate code 4455/);

    fs.rmSync(path.join(LOAD_DOCS_ROOT, shipmentLeadId), { recursive: true, force: true });
});

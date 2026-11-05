import test from "node:test";
import assert from "node:assert/strict";
import { w9MarksFromItems, w9MarksFromText } from "./w9-marks.js";
import { extractFieldsForType } from "./extract.js";
import { validateDocument } from "./validate.js";

test("positioned W-9 marks read name, EIN digits, date, and signature image", () => {
    const marks = w9MarksFromItems(
        [
            { str: "1", x: 62, y: 706 },
            { str: "Green Light Carrier INC", x: 60, y: 689 },
            { str: "2", x: 62, y: 677 },
            { str: "Employer identification number", x: 422, y: 413 },
            { str: "4", x: 423, y: 391 },
            { str: "7", x: 437, y: 391 },
            { str: "1", x: 466, y: 391 },
            { str: "2", x: 480, y: 391 },
            { str: "4", x: 495, y: 391 },
            { str: "9", x: 509, y: 391 },
            { str: "4", x: 524, y: 391 },
            { str: "2", x: 538, y: 391 },
            { str: "7", x: 552, y: 391 },
            { str: "Signature of", x: 78, y: 241 },
            { str: "Date", x: 388, y: 232 },
            { str: "0", x: 425, y: 231 },
            { str: "1", x: 431, y: 231 },
            { str: "/0", x: 436, y: 231 },
            { str: "1", x: 446, y: 231 },
            { str: "/202", x: 452, y: 231 },
            { str: "5", x: 473, y: 231 },
        ],
        [{ x: 141, y: 216, w: 48, h: 42 }]
    );
    assert.equal(marks.name, "Green Light Carrier INC");
    assert.equal(marks.ein, "47-1249427");
    assert.equal(marks.signatureDate, "01/01/2025");
    assert.equal(marks.signed, true);
});

test("a blank signature line is not signed", () => {
    const marks = w9MarksFromText(`
Form W-9
1 Name
2 Business name
Employer identification number
Signature of U.S. person Date
`);
    assert.equal(marks.signed, false);
    assert.equal(marks.ein, null);
});

test("name, EIN, and signature together are Approved", () => {
    const fields = extractFieldsForType(
        "W9",
        `Form W-9
Name QuinStar Logistics LLC
Employer identification number
84-1934519
Signature of U.S. person Ramazan
`
    );
    const result = validateDocument({
        documentType: "W9",
        classifyConfidence: 0.95,
        fields,
    });
    assert.equal(result.trafficLight, "GREEN");
});

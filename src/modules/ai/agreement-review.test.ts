import test from "node:test";
import assert from "node:assert/strict";
import { extractFieldsForType, fieldsToMap } from "./documents/extract.js";
import { validateDocument } from "./documents/validate.js";

const GREEN_LIGHT = `
GREEN LOGISTICS LLC
MC # 1237784 · USDOT # 3622287
Carrier Profile
Carrier Name:
GREEN LIGHT CARRIER INC
DBA:
—
Dispatch Contact:
LIVIU GURIN
Email:
dispatch@greenlightcarrier.com
Phone:
(630) 796-4268
Fax:
—
FED ID #:
—
MC #:
003154
DOT #:
2958246
Address:
3408 BREITWIESER LANE NAPERVILLE, IL
Equipment:
Stepdecks 20+
Payment option:
Factoring company
Factoring company:
RTS Financial
(CARRIER) – GREEN LIGHT CARRIER INC
Printed Name – LIVIU GURIN
Signed at: 2026-11-04T20:07:43.058Z
Electronic signature:
`;

const QUINSTAR = GREEN_LIGHT
    .replace("GREEN LIGHT CARRIER INC", "QUINSTAR LOGISTICS LLC")
    .replace("LIVIU GURIN", "RAMAZAN MUSAYEV")
    .replace("dispatch@greenlightcarrier.com", "quinstarlogistics@gmail.com")
    .replace("(630) 796-4268", "(517) 528-7711")
    .replace("003154", "1541109")
    .replace("2958246", "4061385")
    .replace("3408 BREITWIESER LANE NAPERVILLE, IL", "2083 HAMILTON RD OKEMOS, MI")
    .replace("Stepdecks 20+", "53 ft step deck")
    .replace("RTS Financial", "—");

function review(text: string, greenOs?: { legalName?: string; mcNumber?: string; dotNumber?: string }) {
    const fields = extractFieldsForType("BROKER_CARRIER_AGREEMENT", text);
    return validateDocument({
        documentType: "BROKER_CARRIER_AGREEMENT",
        classifyConfidence: 0.9,
        fields,
        greenOs,
    });
}

test("a filled agreement with dashes in optional lines is Approved", () => {
    const green = review(GREEN_LIGHT);
    const quin = review(QUINSTAR);
    assert.equal(green.trafficLight, "GREEN");
    assert.equal(green.overallStatus, "VALID");
    assert.equal(quin.trafficLight, "GREEN");
    assert.equal(fieldsToMap(extractFieldsForType("BROKER_CARRIER_AGREEMENT", QUINSTAR)).factoringCompany, null);
});

test("a profile missing phone or signature is Not Approved", () => {
    const noPhone = review(GREEN_LIGHT.replace("(630) 796-4268", "—"));
    assert.equal(noPhone.trafficLight, "RED");
    const unsigned = review(GREEN_LIGHT.replace(/Signed at:.*\nElectronic signature:\n/, ""));
    assert.equal(unsigned.trafficLight, "RED");
});

test("carrier name and MC must match the registered carrier when GreenOS has them", () => {
    const same = review(GREEN_LIGHT, {
        legalName: "Green Light Carrier Inc",
        mcNumber: "3154",
        dotNumber: "2958246",
    });
    assert.equal(same.trafficLight, "GREEN");
    const other = review(GREEN_LIGHT, {
        legalName: "QUINSTAR LOGISTICS LLC",
        mcNumber: "1541109",
    });
    assert.equal(other.trafficLight, "RED");
});

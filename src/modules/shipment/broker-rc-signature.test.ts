import assert from "node:assert/strict";
import test from "node:test";
import { brokerUsesLiaSignature } from "./services/load-pdf.service.js";

test("only Lia Torres keeps the stored signature image", () => {
    assert.equal(brokerUsesLiaSignature("Lia Torres"), true);
    assert.equal(brokerUsesLiaSignature("lia torres"), true);
    assert.equal(brokerUsesLiaSignature("Alen Young"), false);
    assert.equal(brokerUsesLiaSignature("Logan"), false);
    assert.equal(brokerUsesLiaSignature(""), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { shortenLoadNumber } from "./load-number.js";

test("old load numbers lose one zero", () => {
    assert.equal(shortenLoadNumber("GL100023"), "GL10023");
    assert.equal(shortenLoadNumber("GL100001"), "GL10001");
    assert.equal(shortenLoadNumber("GL100028"), "GL10028");
    assert.equal(shortenLoadNumber("GL10023"), null);
    assert.equal(shortenLoadNumber("GOS1000328"), null);
});

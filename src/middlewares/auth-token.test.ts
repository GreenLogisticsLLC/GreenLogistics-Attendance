import assert from "node:assert/strict";
import test from "node:test";
import { readRequestToken } from "./auth.middleware.js";

test("customer save can authenticate from the JSON body when the header is missing", () => {
    const req = {
        method: "POST",
        headers: {},
        query: {},
        body: { companyName: "River Valley Excavation LLC", sessionToken: "bob-token" },
    };
    assert.equal(readRequestToken(req as never), "bob-token");
    assert.equal(req.body.sessionToken, undefined);
    assert.equal(req.body.companyName, "River Valley Excavation LLC");
});

test("Authorization header still wins over the body token", () => {
    const req = {
        method: "POST",
        headers: { authorization: "Bearer header-token" },
        query: {},
        body: { sessionToken: "body-token" },
    };
    assert.equal(readRequestToken(req as never), "header-token");
});

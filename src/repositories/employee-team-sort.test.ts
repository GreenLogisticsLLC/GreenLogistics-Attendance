import test from "node:test";
import assert from "node:assert/strict";
import { sortEmployeesByTeam } from "./employee.repository.js";

test("Live Board: Alen first in Team Alen, then brokers, then Team Carl", () => {
    const rows = sortEmployeesByTeam([
        { firstName: "Marry", lastName: "Baxter", department: "Team Alen Young", position: "Broker" },
        { firstName: "Carl", lastName: "Anderson", department: "Team Carl Anderson", position: "Team Lead" },
        { firstName: "Finn", lastName: "Anderson", department: "Team Carl Anderson", position: "Broker" },
        { firstName: "Alen", lastName: "Young", department: "Team Alen Young", position: "Team Lead" },
        { firstName: "Bob", lastName: "Davis", department: "Team Alen Young", position: "Broker" },
        { firstName: "Maddy", lastName: "Clark", department: "Team Carl Anderson", position: "Broker" },
    ]);

    assert.deepEqual(
        rows.map((r) => `${r.firstName} ${r.lastName}`),
        [
            "Alen Young",
            "Marry Baxter",
            "Bob Davis",
            "Carl Anderson",
            "Finn Anderson",
            "Maddy Clark",
        ]
    );
});

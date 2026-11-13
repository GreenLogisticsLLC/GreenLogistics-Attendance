import assert from "node:assert/strict";
import test from "node:test";

type Row = {
    carrierId: string;
    assignedBroker?: { userId: string; firstName: string; lastName: string } | null;
};

function brokerFilterOptions(rows: Row[]) {
    const map: Record<string, string> = {};
    for (const r of rows || []) {
        const b = r && r.assignedBroker;
        if (!b || !b.userId) continue;
        const name = [b.firstName, b.lastName].filter(Boolean).join(" ").trim() || b.userId;
        map[b.userId] = name;
    }
    return Object.keys(map)
        .map((id) => ({ userId: id, name: map[id] }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function filterRows(allRows: Row[], brokerFilter: string) {
    if (brokerFilter === "unassigned") {
        return allRows.filter((r) => !(r.assignedBroker && r.assignedBroker.userId));
    }
    if (brokerFilter) {
        return allRows.filter((r) => r.assignedBroker && r.assignedBroker.userId === brokerFilter);
    }
    return allRows;
}

const sample: Row[] = [
    { carrierId: "c1", assignedBroker: { userId: "b1", firstName: "Rio", lastName: "Clark" } },
    { carrierId: "c2", assignedBroker: { userId: "b2", firstName: "Gary", lastName: "Michael" } },
    { carrierId: "c3", assignedBroker: { userId: "b1", firstName: "Rio", lastName: "Clark" } },
    { carrierId: "c4", assignedBroker: null },
];

test("brokerFilterOptions lists unique brokers sorted by name", () => {
    const opts = brokerFilterOptions(sample);
    assert.deepEqual(
        opts.map((o) => o.userId),
        ["b2", "b1"]
    );
    assert.equal(opts[0].name, "Gary Michael");
    assert.equal(opts[1].name, "Rio Clark");
});

test("filterRows keeps all when broker filter is empty", () => {
    assert.equal(filterRows(sample, "").length, 4);
});

test("filterRows keeps only selected broker", () => {
    const rows = filterRows(sample, "b1");
    assert.deepEqual(
        rows.map((r) => r.carrierId),
        ["c1", "c3"]
    );
});

test("filterRows unassigned keeps carriers without broker", () => {
    const rows = filterRows(sample, "unassigned");
    assert.deepEqual(
        rows.map((r) => r.carrierId),
        ["c4"]
    );
});

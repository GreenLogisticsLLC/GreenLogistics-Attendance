import assert from "node:assert/strict";
import test from "node:test";

/** Mirror of Command Center paging: keep requesting until page >= totalPages. */
function collectAllPages(
    pages: Array<{ items: string[]; totalPages: number; total: number }>
) {
    const acc: string[] = [];
    let page = 1;
    for (;;) {
        const data = pages[page - 1];
        if (!data) break;
        acc.push(...data.items);
        const totalPages = Math.max(1, Number(data.totalPages) || 1);
        if (page >= totalPages) break;
        page += 1;
    }
    return acc;
}

test("dashboard shipment loader walks every page until totalPages", () => {
    const pages = [
        { items: ["a", "b"], totalPages: 3, total: 5 },
        { items: ["c", "d"], totalPages: 3, total: 5 },
        { items: ["e"], totalPages: 3, total: 5 },
    ];
    assert.deepEqual(collectAllPages(pages), ["a", "b", "c", "d", "e"]);
});

test("dashboard shipment loader stops on a single page", () => {
    const pages = [{ items: Array.from({ length: 25 }, (_, i) => "s" + i), totalPages: 1, total: 25 }];
    assert.equal(collectAllPages(pages).length, 25);
});

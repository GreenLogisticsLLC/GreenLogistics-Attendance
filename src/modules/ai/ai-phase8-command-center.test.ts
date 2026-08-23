import assert from "node:assert/strict";
import test from "node:test";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";
import { commandCenterService, _commandCenterTestUtils } from "./command-center/service.js";
import type { AiOperationalItem } from "./command-center/types.js";
import type { AiActionPublicView } from "./actions/types.js";

function item(
    dedupeKey: string,
    priority: AiOperationalItem["priority"],
    category: AiOperationalItem["category"] = "DOCUMENT"
): AiOperationalItem {
    return {
        id: `cc:${dedupeKey}`,
        category,
        priority,
        title: dedupeKey,
        summary: "summary",
        entityType: dedupeKey.startsWith("shipment:") ? "shipment" : "carrier",
        entityId: "entity-1",
        status: "OPEN",
        reason: "reason",
        nextBestAction: "REVIEW_DOCUMENT",
        sources: [{ type: "fixture", id: dedupeKey, label: "fixture" }],
        dedupeKey,
    };
}

test("golden A — critical compliance mismatch is CRITICAL", () => {
    assert.equal(
        _commandCenterTestUtils.determineOperationalPriority({
            category: "COMPLIANCE",
            mismatchStatus: "CRITICAL_MISMATCH",
        }),
        "CRITICAL"
    );
});

test("golden B — missing required carrier document is HIGH", () => {
    assert.equal(
        _commandCenterTestUtils.determineOperationalPriority({
            category: "DOCUMENT",
            documentStatus: "MISSING",
            documentType: "COI",
        }),
        "HIGH"
    );
});

test("golden C — above P75 is HIGH and below P25 is MEDIUM", () => {
    assert.equal(
        _commandCenterTestUtils.determineOperationalPriority({
            marketAssessment: "ABOVE_HISTORICAL_P75",
        }),
        "HIGH"
    );
    assert.equal(
        _commandCenterTestUtils.determineOperationalPriority({
            marketAssessment: "BELOW_HISTORICAL_P25",
        }),
        "MEDIUM"
    );
});

test("golden D — duplicate carrier COI issues consolidate with strongest priority", () => {
    const weak = item("carrier:c1:doc:COI", "MEDIUM");
    const strong = {
        ...item("carrier:c1:doc:COI", "HIGH"),
        sources: [{ type: "document", id: "d1", label: "COI" }],
    };
    const result = _commandCenterTestUtils.dedupeOperationalItems([weak, strong]);
    assert.equal(result.length, 1);
    assert.equal(result[0].priority, "HIGH");
    assert.equal(result[0].sources.length, 2);
});

test("golden E — sorting uses priority then operational category", () => {
    const sorted = _commandCenterTestUtils.sortOperationalItems([
        item("carrier:c1:market", "MEDIUM", "MARKET"),
        item("carrier:c1:compliance", "HIGH", "COMPLIANCE"),
        item("shipment:s1:blocker", "HIGH", "SHIPMENT"),
    ]);
    assert.deepEqual(
        sorted.map((entry) => entry.dedupeKey),
        ["shipment:s1:blocker", "carrier:c1:compliance", "carrier:c1:market"]
    );
});

test("golden F — pending action remains confirmation-gated", () => {
    const action = {
        status: "PENDING_CONFIRMATION",
    } as AiActionPublicView;
    assert.equal(_commandCenterTestUtils.actionDisplayStateOf(action), "PENDING_CONFIRMATION");
    assert.notEqual(_commandCenterTestUtils.actionDisplayStateOf(action), "EXECUTED");
});

test("golden G — disabled center is empty and providers stay NOT_CONNECTED", async () => {
    const previous = process.env.AI_COMMAND_CENTER_ENABLED;
    process.env.AI_COMMAND_CENTER_ENABLED = "false";
    try {
        const result = await commandCenterService.getAttention({
            userId: "fixture-user",
            role: "Viewer",
        });
        assert.deepEqual(result.items, []);
        assert.equal(result.marketProviders.dat, "NOT_CONNECTED");
        assert.equal(result.marketProviders.truckstop, "NOT_CONNECTED");
    } finally {
        if (previous == null) delete process.env.AI_COMMAND_CENTER_ENABLED;
        else process.env.AI_COMMAND_CENTER_ENABLED = previous;
    }
});

test("golden H — chat detects attention and command-center intents", () => {
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("What needs my attention?").kind,
        "my_attention"
    );
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("Open the AI command center").kind,
        "command_center"
    );
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("What is today's top priority?").kind,
        "today_priority"
    );
    assert.equal(
        _aiOrchestratorTestUtils.detectIntent("What is my next best action?").kind,
        "next_best_action"
    );
});

test("empty deterministic summary uses required empty-state language", () => {
    const summary = _commandCenterTestUtils.buildDeterministicDailySummary({
        items: [],
        counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
        generatedAt: "2026-08-23T00:00:00.000Z",
        marketProviders: {
            internal: "AVAILABLE",
            dat: "NOT_CONNECTED",
            truckstop: "NOT_CONNECTED",
        },
    });
    assert.equal(summary.summary, "Nothing requiring attention was found.");
});

test("POD dedupe key is stable", () => {
    assert.equal(
        _commandCenterTestUtils.documentDedupeKey("shipment", "s1", "POD"),
        "shipment:s1:pod:POD"
    );
});

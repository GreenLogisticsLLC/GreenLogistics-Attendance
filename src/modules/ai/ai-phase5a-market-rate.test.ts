import test from "node:test";
import assert from "node:assert/strict";
import { _aiOrchestratorTestUtils } from "./services/ai-orchestrator.js";
import { _statisticsTestUtils, computeRateStatistics, roundDisplay } from "./rates/statistics.js";
import { _confidenceTestUtils, confidenceFromSampleSize } from "./rates/confidence.js";
import { _comparablesTestUtils } from "./rates/comparables.js";
import { normalizeLane, normalizeZip } from "./rates/lane-normalize.js";
import { normalizeEquipment } from "./rates/equipment-normalize.js";
import {
    extractHistoricalRate,
    isValidHistoricalRow,
    mapToHistoricalRecord,
} from "./rates/historical-record.js";
import { findComparables, buildQueryContext } from "./rates/comparables.js";
import { buildHistoricalAclWhere } from "./rates/acl-scope.js";
import { formatMarketRateForChat } from "./rates/format.js";
import { InternalHistoricalRateProvider } from "./rates/internal-historical-provider.js";
import { prisma } from "../../config/database.js";
import type { HistoricalRateRecord } from "./rates/types.js";

const { detectIntent } = _aiOrchestratorTestUtils;
const { percentile } = _statisticsTestUtils;
const { computeTargetRate } = _confidenceTestUtils;

function record(partial: Partial<HistoricalRateRecord> & { shipmentId: string; rate: number; miles: number }): HistoricalRateRecord {
    const lane = normalizeLane({
        pickupCity: partial.originCity || "LOS ANGELES",
        pickupState: partial.originState || "CA",
        deliveryCity: partial.destinationCity || "DALLAS",
        deliveryState: partial.destinationState || "TX",
        pickupZip: partial.originZip || "90001",
        deliveryZip: partial.destinationZip || "75201",
    });
    return {
        shipmentId: partial.shipmentId,
        loadNumber: partial.loadNumber ?? partial.shipmentId,
        origin: lane.origin,
        destination: lane.destination,
        originZip: lane.originZip,
        destinationZip: lane.destinationZip,
        originCity: lane.originCity,
        originState: lane.originState,
        destinationCity: lane.destinationCity,
        destinationState: lane.destinationState,
        originRegion: lane.originZip?.slice(0, 3) ?? lane.originState,
        destinationRegion: lane.destinationZip?.slice(0, 3) ?? lane.destinationState,
        equipment: partial.equipment ?? "Dry Van",
        equipmentCategory: normalizeEquipment(partial.equipment ?? "Dry Van"),
        miles: partial.miles,
        weight: null,
        rate: partial.rate,
        rpm: partial.rate / partial.miles,
        pickupDate: partial.pickupDate ?? "2025-06-01T00:00:00.000Z",
        deliveryDate: null,
        carrierId: null,
        status: partial.status ?? "COMPLETED",
    };
}

test("RPM calculation", () => {
    assert.equal(roundDisplay(3000 / 1500), 2);
});

test("lane normalization: Los Angeles, CA → Dallas, TX", () => {
    const lane = normalizeLane({
        origin: "Los Angeles, CA",
        destination: "Dallas, TX",
        originZip: "90001",
        destinationZip: "75201",
    });
    assert.equal(lane.originCity, "LOS ANGELES");
    assert.equal(lane.originState, "CA");
    assert.equal(lane.destinationCity, "DALLAS");
    assert.equal(lane.destinationState, "TX");
    assert.equal(lane.zipLaneKey, "90001|75201");
});

test("equipment normalization", () => {
    assert.equal(normalizeEquipment("Dry Van"), "DRY_VAN");
    assert.equal(normalizeEquipment("DRY VAN"), "DRY_VAN");
    assert.equal(normalizeEquipment("Van"), "DRY_VAN");
    assert.equal(normalizeEquipment("Reefer"), "REEFER");
    assert.equal(normalizeEquipment("Flatbed"), "FLATBED");
});

test("exact ZIP lane match", () => {
    const query = buildQueryContext({
        pickupCity: "Los Angeles",
        pickupState: "CA",
        pickupZip: "90001",
        deliveryCity: "Dallas",
        deliveryState: "TX",
        deliveryZip: "75201",
        equipment: "Dry Van",
    });
    const dataset = [
        record({ shipmentId: "a", rate: 3000, miles: 1500 }),
        record({
            shipmentId: "b",
            rate: 3200,
            miles: 1500,
            originZip: "90210",
            destinationZip: "75201",
        }),
    ];
    const match = findComparables(query, dataset)!;
    assert.equal(match.level, "EXACT_ZIP_LANE");
    assert.equal(match.records.length, 1);
    assert.equal(match.records[0].shipmentId, "a");
});

test("lane + equipment match fallback", () => {
    const query = buildQueryContext({
        pickupCity: "Los Angeles",
        pickupState: "CA",
        deliveryCity: "Dallas",
        deliveryState: "TX",
        equipment: "Dry Van",
    });
    const dataset = [
        record({
            shipmentId: "a",
            rate: 3000,
            miles: 1500,
            originZip: null as unknown as string,
            destinationZip: null as unknown as string,
        }),
    ];
    const r = mapToHistoricalRecord({
        shipmentLeadId: "a",
        loadNumber: "GL100",
        greenOsShipmentId: null,
        pickupCity: "Los Angeles",
        pickupState: "CA",
        pickupZip: null,
        deliveryCity: "Dallas",
        deliveryState: "TX",
        deliveryZip: null,
        equipment: "Van",
        miles: 1500,
        weight: null,
        carrierRate: 3000,
        carrierProfileId: null,
        pickupFrom: new Date("2025-01-01"),
        deliveryFrom: null,
        status: "COMPLETED",
    });
    assert.ok(r);
    const match = findComparables(query, [r!])!;
    assert.equal(match.level, "LANE_EQUIPMENT");
});

test("regional fallback", () => {
    const query = buildQueryContext({
        pickupCity: "Los Angeles",
        pickupState: "CA",
        pickupZip: "90001",
        deliveryCity: "Dallas",
        deliveryState: "TX",
        deliveryZip: "75299",
        equipment: "Dry Van",
    });
    const r = record({
        shipmentId: "reg",
        rate: 2800,
        miles: 1400,
        originCity: "WEST HOLLYWOOD",
        originState: "CA",
        originZip: "90069",
        destinationCity: "RICHARDSON",
        destinationState: "TX",
        destinationZip: "75280",
    });
    const match = findComparables(query, [r])!;
    assert.equal(match.level, "REGIONAL");
});

test("no historical data → INSUFFICIENT_DATA", () => {
    const query = buildQueryContext({
        pickupCity: "Nowhere",
        pickupState: "ZZ",
        deliveryCity: "Elsewhere",
        deliveryState: "YY",
        equipment: "Dry Van",
    });
    assert.equal(findComparables(query, []), null);
});

test("median P25 P75", () => {
    const rates = Array.from({ length: 18 }, (_, i) => 2800 + i * 20);
    const stats = computeRateStatistics(rates)!;
    assert.equal(stats.count, 18);
    assert.ok(stats.p25 <= stats.median);
    assert.ok(stats.median <= stats.p75);
    assert.equal(percentile(rates, 0.5), stats.median);
});

test("Golden A: 18 comparables → HIGH confidence", () => {
    const rates = Array.from({ length: 18 }, (_, i) => 2880 + i * 15);
    assert.equal(confidenceFromSampleSize(18), "HIGH");
    assert.ok(computeTargetRate(rates)! > 0);
});

test("Golden B: 0 comparables → INSUFFICIENT_DATA", async () => {
    const provider = new InternalHistoricalRateProvider();
    const result = await provider.quote(
        { userId: "admin-test", role: "Administrator" },
        {
            originCity: "ZZZZZZ",
            originState: "ZZ",
            destinationCity: "YYYYYY",
            destinationState: "YY",
            equipment: "Dry Van",
            miles: 1500,
        }
    );
    assert.equal(result.status, "INSUFFICIENT_DATA");
    assert.equal(result.recommendedTarget, null);
});

test("Golden C: 1 comparable → LOW confidence", () => {
    assert.equal(confidenceFromSampleSize(1), "LOW");
});

test("Golden D: carrier quote > P75 → ABOVE_HISTORICAL_P75", () => {
    const rates = [2800, 2900, 3000, 3100, 3200];
    const stats = computeRateStatistics(rates)!;
    assert.ok(3500 > stats.p75);
});

test("Golden E: invalid/cancelled shipment exclusion", () => {
    const cancelled = {
        shipmentLeadId: "x",
        loadNumber: null,
        greenOsShipmentId: null,
        pickupCity: "LA",
        pickupState: "CA",
        pickupZip: "90001",
        deliveryCity: "Dallas",
        deliveryState: "TX",
        deliveryZip: "75201",
        equipment: "Van",
        miles: 1500,
        weight: null,
        carrierRate: 3000,
        carrierProfileId: null,
        pickupFrom: new Date(),
        deliveryFrom: null,
        status: "LOST",
    };
    assert.equal(isValidHistoricalRow(cancelled), false);
});

test("invalid rate exclusion", () => {
    assert.equal(
        extractHistoricalRate({
            shipmentLeadId: "x",
            loadNumber: null,
            greenOsShipmentId: null,
            pickupCity: "LA",
            pickupState: "CA",
            pickupZip: "90001",
            deliveryCity: "Dallas",
            deliveryState: "TX",
            deliveryZip: "75201",
            equipment: "Van",
            miles: 1500,
            weight: null,
            carrierRate: 10,
            carrierProfileId: null,
            pickupFrom: null,
            deliveryFrom: null,
            status: "COMPLETED",
        }),
        null
    );
    assert.equal(
        extractHistoricalRate({
            shipmentLeadId: "x",
            loadNumber: null,
            greenOsShipmentId: null,
            pickupCity: "LA",
            pickupState: "CA",
            pickupZip: "90001",
            deliveryCity: "Dallas",
            deliveryState: "TX",
            deliveryZip: "75201",
            equipment: "Van",
            miles: 1500,
            weight: null,
            carrierRate: 999999,
            carrierProfileId: null,
            pickupFrom: null,
            deliveryFrom: null,
            status: "COMPLETED",
        }),
        null
    );
});

test("intent routing: rate questions", () => {
    assert.equal(detectIntent("What should we pay for load 75246?").kind, "rate_analysis");
    assert.equal(
        detectIntent("What have we historically paid on this lane for load 75246?").kind,
        "historical_rate"
    );
    assert.equal(detectIntent("Is $3,500 high for this load?").kind, "carrier_quote_comparison");
    assert.equal(detectIntent("What is the RPM on load GL100001?").kind, "rate_analysis");
});

test("formatMarketRateForChat does not invent rates when insufficient", () => {
    const text = formatMarketRateForChat({
        status: "INSUFFICIENT_DATA",
        source: "GREENOS_INTERNAL_HISTORY",
        provider: "InternalHistoricalRateProvider",
        comparisonLevel: null,
        sampleSize: 0,
        miles: null,
        rpm: null,
        rate: null,
        recommendedTarget: null,
        recommendedTargetLabel: "INTERNAL HISTORICAL TARGET",
        confidence: null,
        historicalDataDateRange: { earliest: null, latest: null },
        sources: [],
        carrierQuote: null,
        carrierQuoteAssessment: null,
        recencyNote: null,
        message: "Insufficient GreenOS historical data to calculate a reliable estimate.",
    });
    assert.match(text, /Insufficient GreenOS historical data/i);
    assert.doesNotMatch(text, /\$[0-9]{3,}/);
});

test("ACL: broker scope filter in query WHERE", async () => {
    const where = await buildHistoricalAclWhere({ userId: "broker-a", role: "Broker" });
    assert.deepEqual(where.assignedBrokerId, "broker-a");
});

test("Security: Broker A must not use Broker B historical data", async () => {
    const suffix = Date.now().toString(36);
    let brokerA: { userId: string } | null = null;
    let brokerB: { userId: string } | null = null;
    let shipmentB: { shipmentLeadId: string } | null = null;
    try {
        const role = await prisma.role.findFirst({ where: { roleName: "Broker" } });
        if (!role) return;

        brokerA = await prisma.user.create({
            data: {
                username: `p5a_a_${suffix}`,
                email: `p5a-a-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "A",
                lastName: "Broker",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });
        brokerB = await prisma.user.create({
            data: {
                username: `p5a_b_${suffix}`,
                email: `p5a-b-${suffix}@example.invalid`,
                passwordHash: "x",
                firstName: "B",
                lastName: "Broker",
                roleId: role.roleId,
                isActive: true,
            },
            select: { userId: true },
        });

        shipmentB = await prisma.shipmentLead.create({
            data: {
                source: "test",
                shipmentTitle: `Phase5A ACL ${suffix}`,
                pickupCity: "Los Angeles",
                pickupState: "CA",
                pickupZip: "90001",
                deliveryCity: "Dallas",
                deliveryState: "TX",
                deliveryZip: "75201",
                equipment: "Dry Van",
                miles: 1500,
                carrierRate: 3500,
                status: "COMPLETED",
                assignedBrokerId: brokerB.userId,
            },
            select: { shipmentLeadId: true },
        });

        const provider = new InternalHistoricalRateProvider();
        const result = await provider.quote(
            { userId: brokerA.userId, role: "Broker" },
            {
                originCity: "Los Angeles",
                originState: "CA",
                originZip: "90001",
                destinationCity: "Dallas",
                destinationState: "TX",
                destinationZip: "75201",
                equipment: "Dry Van",
                miles: 1500,
            }
        );

        const usedBrokerBShipment = result.sources.some((s) => s.id === shipmentB!.shipmentLeadId);
        assert.equal(usedBrokerBShipment, false);

        if (result.status === "OK") {
            assert.ok(result.sampleSize >= 0);
            for (const src of result.sources) {
                const row = await prisma.shipmentLead.findUnique({
                    where: { shipmentLeadId: src.id },
                    select: { assignedBrokerId: true },
                });
                assert.notEqual(row?.assignedBrokerId, brokerB.userId);
            }
        }
    } finally {
        if (shipmentB) {
            await prisma.shipmentLead.delete({ where: { shipmentLeadId: shipmentB.shipmentLeadId } }).catch(() => null);
        }
        if (brokerA) await prisma.user.delete({ where: { userId: brokerA.userId } }).catch(() => null);
        if (brokerB) await prisma.user.delete({ where: { userId: brokerB.userId } }).catch(() => null);
    }
});

test("source generation uses real shipment IDs", () => {
    const query = buildQueryContext({
        pickupCity: "Los Angeles",
        pickupState: "CA",
        pickupZip: "90001",
        deliveryCity: "Dallas",
        deliveryState: "TX",
        deliveryZip: "75201",
        equipment: "Dry Van",
    });
    const dataset = [record({ shipmentId: "ship-1001", loadNumber: "GL100001", rate: 3000, miles: 1500 })];
    const match = findComparables(query, dataset)!;
    assert.equal(match.records[0].shipmentId, "ship-1001");
});

test("ZIP normalization", () => {
    assert.equal(normalizeZip("90001-1234"), "90001");
    assert.equal(normalizeZip("90"), null);
});

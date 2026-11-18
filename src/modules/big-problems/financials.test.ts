import assert from "node:assert/strict";
import test from "node:test";
import { computeBigProblemFinancials } from "./financials.js";
import {
    canDeleteBigProblemCase,
    canEditBigProblemFinancials,
    canViewBigProblemCase,
    canViewBigProblemFinancials,
} from "./permissions.js";

test("potential exposure excludes carrier and insurance claims (no double-count)", () => {
    const f = computeBigProblemFinancials({
        customerClaimAmount: 1000,
        carrierClaimAmount: 1000,
        insuranceClaimAmount: 1000,
        customerCompensation: 200,
        legalExpenses: 50,
        otherExpenses: 25,
        amountRecovered: 0,
        insuranceStatus: "PENDING",
    });
    assert.equal(f.potentialExposure, 1275);
    assert.equal(f.carrierClaimAmount, 1000);
    assert.equal(f.insuranceClaimAmount, 1000);
    assert.equal(f.outstandingExposure, 1275);
    assert.equal(f.actualNetLoss, 1275);
});

test("pending insurance does not reduce outstanding exposure", () => {
    const f = computeBigProblemFinancials({
        customerClaimAmount: 5000,
        insuranceClaimAmount: 5000,
        insuranceStatus: "PENDING",
        amountRecovered: 0,
    });
    assert.equal(f.amountRecovered, 0);
    assert.equal(f.outstandingExposure, 5000);
});

test("confirmed recovery reduces net loss and outstanding", () => {
    const f = computeBigProblemFinancials({
        customerClaimAmount: 5000,
        legalExpenses: 500,
        amountRecovered: 2000,
        insuranceStatus: "PAID",
        insuranceClaimAmount: 2000,
    });
    assert.equal(f.potentialExposure, 5500);
    assert.equal(f.actualNetLoss, 3500);
    assert.equal(f.outstandingExposure, 3500);
});

test("broker cannot view or edit financials; accounting can", () => {
    assert.equal(canViewBigProblemFinancials("Broker"), false);
    assert.equal(canEditBigProblemFinancials("Broker"), false);
    assert.equal(canViewBigProblemFinancials("Accounting"), true);
    assert.equal(canEditBigProblemFinancials("Accounting"), true);
    assert.equal(canEditBigProblemFinancials("Manager"), true);
});

test("only Owner / Administrator may hard-delete cases", () => {
    assert.equal(canDeleteBigProblemCase("Owner"), true);
    assert.equal(canDeleteBigProblemCase("Administrator"), true);
    assert.equal(canDeleteBigProblemCase("Manager"), false);
    assert.equal(canDeleteBigProblemCase("Team Lead"), false);
    assert.equal(canDeleteBigProblemCase("Broker"), false);
    assert.equal(canDeleteBigProblemCase("Accounting"), false);
});

test("broker case visibility is scoped to participation or task assignment", () => {
    const broker = { userId: "b1", role: "Broker" };
    assert.equal(
        canViewBigProblemCase(broker, { brokerUserId: "b1" }),
        true
    );
    assert.equal(
        canViewBigProblemCase(broker, { taskAssigneeIds: ["b1"] }),
        true
    );
    assert.equal(
        canViewBigProblemCase(broker, { brokerUserId: "other" }),
        false
    );
    assert.equal(
        canViewBigProblemCase({ userId: "m1", role: "Manager" }, { brokerUserId: "other" }),
        true
    );
});

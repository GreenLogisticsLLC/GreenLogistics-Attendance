import test from "node:test";
import assert from "node:assert/strict";
import {
    filterPeriodReportRows,
    rowMatchesReportFilters,
    summarizePeriodReportRows,
} from "./report-filter.js";

type PeriodReportRow = {
    workDate: string;
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    department: string | null;
    position: string | null;
    firstEntry: string | null;
    lastExit: string | null;
    status: string;
    totalOutsideMinutes: number;
    timeInOfficeMinutes: number;
    overtimeInOfficeMinutes: number;
    exitCount: number;
};

function row(partial: Partial<PeriodReportRow> & { employeeId: string; employeeName: string }): PeriodReportRow {
    return {
        workDate: "2026-10-20",
        employeeNumber: "GL-001",
        department: "Team Alen Young",
        position: "Broker",
        firstEntry: "17:02:00",
        lastExit: "02:10:00",
        status: "Left",
        totalOutsideMinutes: 30,
        timeInOfficeMinutes: 480,
        overtimeInOfficeMinutes: 20,
        exitCount: 1,
        ...partial,
    };
}

test("filters attendance rows by employee id", () => {
    const rows = [
        row({ employeeId: "a", employeeName: "Alen Young" }),
        row({ employeeId: "c", employeeName: "Carl Anderson", department: "Team Carl Anderson" }),
    ];
    const filtered = filterPeriodReportRows(rows, { employeeId: "c" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].employeeName, "Carl Anderson");
});

test("filters attendance rows by broker name, number, department, or position", () => {
    const rows = [
        row({ employeeId: "a", employeeName: "Alen Young", employeeNumber: "GL-010" }),
        row({
            employeeId: "f",
            employeeName: "Finn Anderson",
            employeeNumber: "GL-022",
            department: "Team Carl Anderson",
            position: "Broker",
        }),
        row({
            employeeId: "m",
            employeeName: "Maddy Clark",
            department: "Team Carl Anderson",
            position: "Broker",
        }),
    ];
    assert.equal(filterPeriodReportRows(rows, { name: "alen" }).length, 1);
    assert.equal(filterPeriodReportRows(rows, { name: "GL-022" })[0].employeeId, "f");
    assert.equal(filterPeriodReportRows(rows, { name: "finn" }).length, 1);
    assert.equal(filterPeriodReportRows(rows, { name: "broker" }).length, 3);
});

test("combines employee select with name search", () => {
    const rows = [
        row({ employeeId: "a", employeeName: "Alen Young" }),
        row({ employeeId: "c", employeeName: "Carl Anderson", department: "Team Carl Anderson" }),
    ];
    assert.equal(filterPeriodReportRows(rows, { employeeId: "a", name: "carl" }).length, 0);
    assert.equal(filterPeriodReportRows(rows, { employeeId: "a", name: "young" }).length, 1);
    assert.equal(rowMatchesReportFilters(rows[0], {}), true);
});

test("summary follows filtered rows", () => {
    const rows = [
        row({ employeeId: "a", employeeName: "Alen Young", timeInOfficeMinutes: 100, firstEntry: "17:00:00" }),
        row({ employeeId: "c", employeeName: "Carl Anderson", timeInOfficeMinutes: 50, firstEntry: null }),
    ];
    const summary = summarizePeriodReportRows(filterPeriodReportRows(rows, { employeeId: "a" }));
    assert.equal(summary.totalSessions, 1);
    assert.equal(summary.daysWithEntry, 1);
    assert.equal(summary.totalInOfficeMinutes, 100);
});

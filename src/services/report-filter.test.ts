import test from "node:test";
import assert from "node:assert/strict";
import {
    filterPeriodReportRows,
    groupNotArrivedByEmployee,
    isNotArrivedRow,
    lastCountableWorkDate,
    listDateStrings,
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

test("Not Arrived filter keeps only days without an entry", () => {
    const rows = [
        row({ employeeId: "a", employeeName: "Alen Young", firstEntry: "17:00:00", status: "Left" }),
        row({
            employeeId: "a",
            employeeName: "Alen Young",
            firstEntry: null,
            status: "Not Arrived",
            workDate: "2026-10-19",
        }),
        row({
            employeeId: "c",
            employeeName: "Carl Anderson",
            firstEntry: null,
            status: "Not Arrived",
            workDate: "2026-10-19",
        }),
    ];
    const filtered = filterPeriodReportRows(rows, { status: "not_arrived" });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((r) => isNotArrivedRow(r)));
});

test("groups Not Arrived days per employee for the period", () => {
    const rows = [
        row({ employeeId: "a", employeeName: "Alen Young", firstEntry: null, status: "Not Arrived", workDate: "2026-10-18" }),
        row({ employeeId: "a", employeeName: "Alen Young", firstEntry: null, status: "Not Arrived", workDate: "2026-10-20" }),
        row({ employeeId: "c", employeeName: "Carl Anderson", firstEntry: null, status: "Not Arrived", workDate: "2026-10-19" }),
    ];
    const grouped = groupNotArrivedByEmployee(rows);
    assert.equal(grouped[0].employeeName, "Alen Young");
    assert.equal(grouped[0].daysNotArrived, 2);
    assert.deepEqual(grouped[0].dates, ["2026-10-18", "2026-10-20"]);
    assert.equal(grouped[1].daysNotArrived, 1);
});

test("lists inclusive work dates and caps Not Arrived before the shift starts", () => {
    assert.deepEqual(listDateStrings("2026-10-18", "2026-10-20"), [
        "2026-10-18",
        "2026-10-19",
        "2026-10-20",
    ]);
    assert.equal(lastCountableWorkDate("2026-10-20", "2026-10-20", false), "2026-10-19");
    assert.equal(lastCountableWorkDate("2026-10-20", "2026-10-20", true), "2026-10-20");
    assert.equal(lastCountableWorkDate("2026-10-15", "2026-10-20", false), "2026-10-15");
});

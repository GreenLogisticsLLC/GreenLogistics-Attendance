import { Request, Response } from "express";
import PDFDocument from "pdfkit";
import { reportService } from "../services/report.service.js";
import { apiResponse, formatMinutes } from "../utils/helpers.js";

function parseDateRange(req: Request): { from: string; to: string } | null {
    const from = (req.query.from as string)?.trim();
    const to = (req.query.to as string)?.trim();
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return null;
    }
    if (from > to) return null;
    return { from, to };
}

function parseReportFilters(req: Request): { employeeId?: string; name?: string; status?: string } {
    const employeeId = String(req.query.employeeId || "").trim();
    const name = String(req.query.name || req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    return {
        ...(employeeId ? { employeeId } : {}),
        ...(name ? { name } : {}),
        ...(status ? { status } : {}),
    };
}

function reportFilterLabel(report: {
    filters?: { employeeId?: string | null; name?: string | null; status?: string | null };
    rows: Array<{ employeeName: string }>;
}): string | null {
    const bits: string[] = [];
    const name = report.filters?.name?.trim();
    if (name) bits.push(`Name: ${name}`);
    if (report.filters?.employeeId) {
        const unique = [...new Set(report.rows.map((r) => r.employeeName).filter(Boolean))];
        bits.push(unique.length === 1 ? `Employee: ${unique[0]}` : "Selected employee");
    }
    if (report.filters?.status === "not_arrived") bits.push("Status: Not Arrived");
    return bits.length ? bits.join(" · ") : null;
}

export async function periodReportController(req: Request, res: Response) {
    const range = parseDateRange(req);
    if (!range) {
        return res.status(422).json(apiResponse(false, "Invalid date range — use from=YYYY-MM-DD&to=YYYY-MM-DD"));
    }

    const report = await reportService.getPeriodReport(range.from, range.to, parseReportFilters(req));
    return res.json(apiResponse(true, "Period report generated", report));
}

export async function periodReportPdfController(req: Request, res: Response) {
    const range = parseDateRange(req);
    if (!range) {
        return res.status(422).json(apiResponse(false, "Invalid date range"));
    }

    const filters = parseReportFilters(req);
    const report = await reportService.getPeriodReport(range.from, range.to, filters);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="attendance-${range.from}-${range.to}.pdf"`
    );

    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    doc.pipe(res);

    doc.fontSize(18).text(report.company, { align: "center" });
    doc.fontSize(14).text("Attendance Report", { align: "center" });
    doc
        .fontSize(10)
        .fillColor("#666")
        .text(`Period: ${range.from} — ${range.to}`, { align: "center" });
    const filterLine = reportFilterLabel(report);
    if (filterLine) {
        doc.text(filterLine, { align: "center" });
    }
    doc.text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.moveDown(1.5);
    doc.fillColor("#000");

    doc.fontSize(11).text("Summary", { underline: true });
    doc.fontSize(10);
    if (report.filters?.status === "not_arrived") {
        doc.text(`Employees who did not arrive: ${report.summary.employeesNotArrived}`);
        doc.text(`Days not arrived: ${report.summary.daysNotArrived}`);
    } else {
        doc.text(`Records: ${report.summary.totalSessions}`);
        doc.text(`Days with entry: ${report.summary.daysWithEntry}`);
        doc.text(`Days not arrived: ${report.summary.daysNotArrived}`);
        doc.text(`Total in office: ${formatMinutes(report.summary.totalInOfficeMinutes)}`);
        doc.text(`Total outside: ${formatMinutes(report.summary.totalOutsideMinutes)}`);
        doc.text(`OutTime in office: ${formatMinutes(report.summary.totalOvertimeMinutes)}`);
    }
    doc.moveDown(1);

    const absenceSummary = report.notArrivedByEmployee || [];
    if (report.filters?.status === "not_arrived" && absenceSummary.length) {
        doc.fontSize(11).fillColor("#000").text("Days not arrived by employee", { underline: true });
        doc.fontSize(9);
        doc.moveDown(0.3);
        for (const item of absenceSummary) {
            if (doc.y > 520) doc.addPage();
            doc.text(
                `${item.employeeName} (${item.employeeNumber}) — ${item.daysNotArrived} day(s): ${item.dates.join(", ")}`
            );
        }
        doc.moveDown(1);
    }

    const colX = [40, 95, 180, 245, 305, 365, 430, 495, 570];
    const headers = [
        "Date",
        "Employee",
        "Dept",
        "Entry",
        "Exit",
        "In Office",
        "Outside",
        "OutTime",
        "Status",
    ];

    function drawHeader() {
        doc.fontSize(8).fillColor("#333");
        headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { width: 80, continued: false }));
        doc.moveDown(0.3);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke("#ccc");
        doc.moveDown(0.3);
    }

    drawHeader();

    for (const row of report.rows) {
        if (doc.y > 510) {
            doc.addPage();
            drawHeader();
        }

        const y = doc.y;
        doc.fontSize(7).fillColor("#000");
        doc.text(row.workDate, colX[0], y, { width: 52 });
        doc.text(`${row.employeeName}\n${row.employeeNumber}`, colX[1], y, { width: 75 });
        doc.text(row.department || "—", colX[2], y, { width: 52 });
        doc.text(row.firstEntry || "—", colX[3], y, { width: 58 });
        doc.text(row.lastExit || "—", colX[4], y, { width: 58 });
        doc.text(formatMinutes(row.timeInOfficeMinutes), colX[5], y, { width: 55 });
        doc.text(formatMinutes(row.totalOutsideMinutes), colX[6], y, { width: 55 });
        doc.text(formatMinutes(row.overtimeInOfficeMinutes), colX[7], y, { width: 60 });
        doc.text(row.status, colX[8], y, { width: 100 });

        doc.y = y + 28;
    }

    if (!report.rows.length) {
        doc.fontSize(10).text("No attendance records for this period.", { align: "center" });
    }

    doc.end();
}

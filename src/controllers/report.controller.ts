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

export async function periodReportController(req: Request, res: Response) {
    const range = parseDateRange(req);
    if (!range) {
        return res.status(422).json(apiResponse(false, "Invalid date range — use from=YYYY-MM-DD&to=YYYY-MM-DD"));
    }

    const report = await reportService.getPeriodReport(range.from, range.to);
    return res.json(apiResponse(true, "Period report generated", report));
}

export async function periodReportPdfController(req: Request, res: Response) {
    const range = parseDateRange(req);
    if (!range) {
        return res.status(422).json(apiResponse(false, "Invalid date range"));
    }

    const report = await reportService.getPeriodReport(range.from, range.to);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="attendance-${range.from}-${range.to}.pdf"`
    );

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);

    doc.fontSize(18).text(report.company, { align: "center" });
    doc.fontSize(14).text("Attendance Report", { align: "center" });
    doc
        .fontSize(10)
        .fillColor("#666")
        .text(`Period: ${range.from} — ${range.to}`, { align: "center" });
    doc.text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.moveDown(1.5);
    doc.fillColor("#000");

    doc.fontSize(11).text("Summary", { underline: true });
    doc.fontSize(10);
    doc.text(`Records: ${report.summary.totalSessions}`);
    doc.text(`Days with entry: ${report.summary.daysWithEntry}`);
    doc.text(`Total in office: ${formatMinutes(report.summary.totalInOfficeMinutes)}`);
    doc.text(`Total outside: ${formatMinutes(report.summary.totalOutsideMinutes)}`);
    doc.text(`Total late: ${formatMinutes(report.summary.totalLateMinutes)}`);
    doc.moveDown(1);

    const colX = [40, 92, 167, 217, 275, 333, 390, 450];
    const headers = ["Date", "Employee", "Dept", "Entry", "Exit", "In Office", "Outside", "Status"];

    function drawHeader() {
        doc.fontSize(8).fillColor("#333");
        headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { width: 80, continued: false }));
        doc.moveDown(0.3);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke("#ccc");
        doc.moveDown(0.3);
    }

    drawHeader();

    for (const row of report.rows) {
        if (doc.y > 720) {
            doc.addPage();
            drawHeader();
        }

        const y = doc.y;
        doc.fontSize(7).fillColor("#000");
        doc.text(row.workDate, colX[0], y, { width: 52 });
        doc.text(`${row.employeeName}\n${row.employeeNumber}`, colX[1], y, { width: 75 });
        doc.text(row.department || "—", colX[2], y, { width: 52 });
        doc.text(row.firstEntry?.split(",")[1]?.trim() || row.firstEntry || "—", colX[3], y, { width: 58 });
        doc.text(row.lastExit?.split(",")[1]?.trim() || row.lastExit || "—", colX[4], y, { width: 58 });
        doc.text(formatMinutes(row.timeInOfficeMinutes), colX[5], y, { width: 55 });
        doc.text(formatMinutes(row.totalOutsideMinutes), colX[6], y, { width: 55 });
        doc.text(row.status, colX[7], y, { width: 65 });

        doc.y = y + 28;
    }

    if (!report.rows.length) {
        doc.fontSize(10).text("No attendance records for this period.", { align: "center" });
    }

    doc.end();
}

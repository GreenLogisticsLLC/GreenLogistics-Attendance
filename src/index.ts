import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { apiRouter } from "./routes/api.routes.js";
import { config } from "./config/env.js";
import { configureSqlite } from "./config/database.js";
import { attendanceService } from "./services/attendance.service.js";
import { startEmailImportScheduler } from "./modules/email/scheduler.js";
import { startAssignmentAcceptanceScheduler } from "./modules/assignment/assignment-acceptance.scheduler.js";
import { assignmentEngine } from "./modules/assignment/assignment.engine.js";
import { startBrokerResponseTimeoutScheduler } from "./modules/crm/broker-response-timeout.scheduler.js";
import { startCarrierViewReconciliation } from "./modules/tracking/scheduler.js";
import { startDocumentAiScheduler } from "./modules/ai/documents/scheduler.js";
import { startCarrierMissingScheduler } from "./modules/shipment/carrier-missing.scheduler.js";
import { carrierService } from "./modules/carriers/services/carrier.service.js";
import { backfillMissingGreenOsShipmentIds, remigrateAllGreenOsShipmentIds } from "./modules/shipment/shipment.id.js";
import { getWebhookUrls, getAllNetworkIps } from "./utils/helpers.js";
import { resetShipmentsForEpoch } from "./services/shipment-epoch-reset.js";
import { assignRioClarkToAlenYoung } from "./services/assign-rio-clark.js";
import { revertFalseAcceptGos1000040 } from "./services/revert-false-accept-gos1000040.js";
import { restoreGl10065FromVoided } from "./services/restore-gl10065-from-voided.js";
import { wipeRegisteredCarriers } from "./services/wipe-registered-carriers.js";
import { shortenExistingLoadNumbers } from "./modules/shipment/load-number.js";
import { startBirthdayScheduler } from "./services/birthday-notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("trust proxy", 1);

app.use(cors({ origin: config.corsOrigins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
app.use(
    express.json({
        limit: "3mb",
        verify: (req, _res, buf) => {
            const request = req as express.Request & { rawBody?: string };
            const url = String(request.originalUrl || request.url || "");
            if (url.includes("/webhooks/paypal")) {
                request.rawBody = buf.toString("utf8");
            }
        },
    })
);

app.use((req, _res, next) => {
    if (req.path.includes("/webhook/attendance") && req.method === "POST") {
        console.log(`[WEBHOOK] ${new Date().toISOString()} from ${req.ip}`);
    }
    next();
});

app.use("/api", apiRouter);

// API routes must never fall through to HTML — the Accounting UI treats HTML as "Bad response".
app.use("/api", (req, res) => {
    res.status(404).json({
        success: false,
        message: `API route not found: ${req.method} ${req.originalUrl}`,
    });
});

app.use(
    (
        err: unknown,
        req: express.Request,
        res: express.Response,
        _next: express.NextFunction
    ) => {
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status?: number }).status) || 500
                : 500;
        const message = err instanceof Error ? err.message : "Server error";
        if (req.path.startsWith("/api") || req.originalUrl.startsWith("/api")) {
            if (!res.headersSent) {
                res.status(status).json({ success: false, message });
            }
            return;
        }
        if (!res.headersSent) {
            res.status(status).send(message);
        }
    }
);

const frontendPath = path.join(__dirname, "..", "frontend", "public");
app.use(express.static(frontendPath));

app.get("/carrier/onboarding/:token", (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(frontendPath, "carrier-onboarding.html"));
});

app.get("/customer/agreement/:token", (_req, res) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(frontendPath, "customer-agreement.html"));
});

app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

setInterval(() => {
    attendanceService.closeExpiredSessions().catch(console.error);
}, 5 * 60 * 1000);

startEmailImportScheduler(config.emailPollIntervalMs);
startAssignmentAcceptanceScheduler(60_000);
startBrokerResponseTimeoutScheduler(30_000);
startCarrierViewReconciliation();
startDocumentAiScheduler(15_000);
startCarrierMissingScheduler();

app.listen(config.port, config.host, async () => {
    await configureSqlite();
    try {
        await resetShipmentsForEpoch();
    } catch (err) {
        console.warn("[reset] shipment wipe skipped:", err);
    }
    try {
        await assignRioClarkToAlenYoung();
    } catch (err) {
        console.warn("[team] Rio Clark assignment skipped:", err);
    }
    try {
        await assignmentEngine.spreadRioClarkWaitingShipments();
        await assignmentEngine.restoreRichNightShipments();
    } catch (err) {
        console.warn("[assignment] Rio Clark waiting spread skipped:", err);
    }
    try {
        await shortenExistingLoadNumbers();
    } catch (err) {
        console.warn("[load-number] shorten skipped:", err);
    }
    try {
        await revertFalseAcceptGos1000040();
    } catch (err) {
        console.warn("[shipment] GOS1000040 revert skipped:", err);
    }
    try {
        await restoreGl10065FromVoided();
    } catch (err) {
        console.warn("[shipment] GL10065 unvoid skipped:", err);
    }
    try {
        await wipeRegisteredCarriers();
    } catch (err) {
        console.warn("[carriers] registered carrier wipe skipped:", err);
    }
    try {
        const remapped = await remigrateAllGreenOsShipmentIds();
        if (remapped > 0) {
            console.log(`[shipment] Remigrated ${remapped} Green OS Shipment ID(s) → GOS1000001…`);
        }
        const n = await backfillMissingGreenOsShipmentIds();
        if (n > 0) console.log(`[shipment] Backfilled ${n} Green OS Shipment ID(s)`);
    } catch (err) {
        console.warn("[shipment] Green OS ID backfill/remigrate skipped:", err);
    }
    try {
        startBirthdayScheduler();
    } catch (err) {
        console.warn("[birthday] scheduler skipped:", err);
    }
    try {
        await carrierService.collapseDuplicateAgreementDocuments();
        await carrierService.regenerateAllSignedAgreementPdfsOnce();
    } catch (err) {
        console.warn("[agreement-pdf] signed PDF regenerate skipped:", err);
    }
    const urls = getWebhookUrls(config.port);
    const ips = getAllNetworkIps();
    console.log(`Green Logistics Attendance / GreenOS v1.0.0`);
    console.log(`Server:   http://localhost:${config.port}  (listening on ${config.host})`);
    console.log(`Webhook:  ${urls.local}`);
    if (urls.network) {
        console.log(`Webhook (LAN — give this to Legacy Reader): ${urls.network}`);
    } else {
        console.log(`Webhook (LAN): could not detect IP — run ipconfig and use your Wi-Fi IPv4`);
    }
    if (ips.length) console.log(`Network IPs: ${ips.join(", ")}`);
    console.log(`Health:   GET http://localhost:${config.port}/api/health`);
    console.log(`Email:    GET/POST http://localhost:${config.port}/api/email/*`);
    console.log(`CRM:      GET/PATCH http://localhost:${config.port}/api/crm/*`);
    console.log(`Shipments: GET/POST http://localhost:${config.port}/api/shipments/*`);
    console.log(`Assign:   GET http://localhost:${config.port}/api/assignment/*`);
    console.log(`Gmail OAuth: http://localhost:${config.port}/api/email/auth`);
});

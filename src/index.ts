import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { apiRouter } from "./routes/api.routes.js";
import { config } from "./config/env.js";
import { configureSqlite } from "./config/database.js";
import { attendanceService } from "./services/attendance.service.js";
import { startEmailImportScheduler } from "./modules/email/scheduler.js";
import { getWebhookUrls, getAllNetworkIps } from "./utils/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("trust proxy", 1);

app.use(cors({ origin: config.corsOrigins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

app.use((req, _res, next) => {
    if (req.path.includes("/webhook/attendance") && req.method === "POST") {
        console.log(`[WEBHOOK] ${new Date().toISOString()} from ${req.ip}`);
    }
    next();
});

app.use("/api", apiRouter);

const frontendPath = path.join(__dirname, "..", "frontend", "public");
app.use(express.static(frontendPath));

app.get("*", (_req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
});

setInterval(() => {
    attendanceService.closeExpiredSessions().catch(console.error);
}, 5 * 60 * 1000);

startEmailImportScheduler(config.emailPollIntervalMs);

app.listen(config.port, config.host, async () => {
    await configureSqlite();
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
    console.log(`Assign:   GET http://localhost:${config.port}/api/assignment/*`);
    console.log(`Gmail OAuth: http://localhost:${config.port}/api/email/auth`);
});

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { apiRouter } from "./routes/api.routes.js";
import { config } from "./config/env.js";
import { attendanceService } from "./services/attendance.service.js";
import { getWebhookUrls, getAllNetworkIps } from "./utils/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
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

app.listen(config.port, config.host, () => {
    const urls = getWebhookUrls(config.port);
    const ips = getAllNetworkIps();
    console.log(`Green Logistics Attendance v1.0.0`);
    console.log(`Server:   http://localhost:${config.port}  (listening on ${config.host})`);
    console.log(`Webhook:  ${urls.local}`);
    if (urls.network) {
        console.log(`Webhook (LAN — give this to Legacy Reader): ${urls.network}`);
    } else {
        console.log(`Webhook (LAN): could not detect IP — run ipconfig and use your Wi-Fi IPv4`);
    }
    if (ips.length) console.log(`Network IPs: ${ips.join(", ")}`);
    console.log(`Health:   GET http://localhost:${config.port}/api/health`);
});

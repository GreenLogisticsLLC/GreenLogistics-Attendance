/**
 * One-shot: resend PENDING registration approvals via Gmail API (OAuth).
 * Run on Contabo from project root with env loaded from .env / DB settings.
 *
 *   node scripts/resend-approvals-on-server.mjs
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { google } = require("googleapis");
const jwt = require("jsonwebtoken");

function loadEnvFile(envPath) {
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!m) continue;
        if (process.env[m[1]] !== undefined) continue;
        let v = m[2].trim();
        if (
            (v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))
        ) {
            v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
    }
}

function encodeSubject(subject) {
    if (/^[\x20-\x7E]*$/.test(subject)) return subject;
    return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildRaw({ from, to, subject, text, html }) {
    const boundary = `greenos_${Date.now()}`;
    const raw = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${encodeSubject(subject)}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        text,
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "",
        html,
        `--${boundary}--`,
        "",
    ].join("\r\n");
    return Buffer.from(raw)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function openSqlite(dbPath) {
    const { execFileSync } = require("child_process");
    const py = `
import sqlite3, json, sys
con = sqlite3.connect(sys.argv[1])
con.row_factory = sqlite3.Row
cur = con.cursor()
sql = sys.argv[2]
rows = [dict(r) for r in cur.execute(sql).fetchall()]
print(json.dumps(rows))
con.close()
`;
    return {
        all(sql) {
            const out = execFileSync("python3", ["-c", py, dbPath, sql], {
                encoding: "utf8",
            });
            return JSON.parse(out);
        },
        get(sql) {
            const rows = this.all(sql);
            return rows[0] || null;
        },
    };
}

async function main() {
    const root = process.cwd();
    loadEnvFile(path.join(root, ".env"));

    const approval =
        process.env.APPROVAL_EMAIL || "effiegreenlogistics@gmail.com";
    const publicApp = (
        process.env.PUBLIC_APP_URL || "https://os.greengrouplogistics.com"
    ).replace(/\/$/, "");
    const jwtSecret = process.env.JWT_SECRET;
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const redirectUri =
        process.env.GMAIL_REDIRECT_URI || `${publicApp}/api/email/callback`;

    if (!jwtSecret) throw new Error("JWT_SECRET missing");
    if (!clientId || !clientSecret) throw new Error("GMAIL_CLIENT_ID/SECRET missing");

    const dbUrl = process.env.DATABASE_URL || "file:./data/attendance.db";
    const candidates = [];
    if (dbUrl.startsWith("file:")) candidates.push(dbUrl.slice(5));
    candidates.push(
        path.join(root, "data", "attendance.db"),
        path.join(root, "prisma", "data", "attendance.db")
    );
    const dbPath = candidates.find((p) => fs.existsSync(p));
    if (!dbPath) throw new Error("SQLite DB not found");

    const db = openSqlite(dbPath);
    const userRow = db.get(
        "SELECT setting_value AS v FROM settings WHERE category='gmail' AND setting_key='user'"
    );
    const refreshRow = db.get(
        "SELECT setting_value AS v FROM settings WHERE category='gmail' AND setting_key='refresh_token'"
    );
    const refreshToken =
        (refreshRow && refreshRow.v) || process.env.GMAIL_REFRESH_TOKEN || "";
    const fromAddr =
        (userRow && userRow.v) ||
        process.env.GMAIL_USER ||
        approval;

    if (!refreshToken) {
        throw new Error("No Gmail refresh token — open /api/email/auth as effie");
    }

    const pending = db.all(
        "SELECT pending_id, username, email, first_name, last_name, requested_role FROM pending_registrations WHERE status='PENDING'"
    );

    console.log(`DB=${dbPath}`);
    console.log(`From=${fromAddr} To=${approval} Pending=${pending.length}`);

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oauth2.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    for (const p of pending) {
        const token = jwt.sign(
            { pendingId: p.pending_id, purpose: "registration-approval" },
            jwtSecret,
            { expiresIn: "7d" }
        );
        const approveUrl = `${publicApp}/api/v1/auth/registration/approve?token=${encodeURIComponent(token)}`;
        const rejectUrl = `${publicApp}/api/v1/auth/registration/reject?token=${encodeURIComponent(token)}`;
        const subject = `[Green OS] Registration request — ${p.first_name} ${p.last_name} (${p.requested_role})`;
        const text = [
            `Name: ${p.first_name} ${p.last_name}`,
            `Username: ${p.username}`,
            `Email: ${p.email}`,
            `Role: ${p.requested_role}`,
            `Approve: ${approveUrl}`,
            `Reject: ${rejectUrl}`,
        ].join("\n");
        const html = `<p><strong>${p.first_name} ${p.last_name}</strong> (${p.username}) requested <strong>${p.requested_role}</strong>.</p>
<p><a href="${approveUrl}">Approve</a> &nbsp; <a href="${rejectUrl}">Reject</a></p>`;

        await gmail.users.messages.send({
            userId: "me",
            requestBody: {
                raw: buildRaw({ from: fromAddr, to: approval, subject, text, html }),
            },
        });
        console.log("SENT", p.username, "->", approval);
        console.log("APPROVE", approveUrl);
        console.log("REJECT", rejectUrl);
    }

    await gmail.users.messages.send({
        userId: "me",
        requestBody: {
            raw: buildRaw({
                from: fromAddr,
                to: approval,
                subject: "[Green OS] Mail test — approval channel OK",
                text: "If you see this in effiegreenlogistics@gmail.com, approval mail works. Check Inbox, Spam, and Sent.",
                html: "<p>If you see this in <strong>effiegreenlogistics@gmail.com</strong>, approval mail works.</p><p>Check Inbox, Spam, and Sent.</p>",
            }),
        },
    });
    console.log("TEST ping sent to", approval);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

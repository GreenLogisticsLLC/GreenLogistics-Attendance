#!/usr/bin/env node
/**
 * Preflight before PM2 restart / Contabo deploy.
 * Fails if Express or dist entry cannot resolve — prevents MODULE_NOT_FOUND flaps.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

function fail(msg) {
    console.error(`[validate-runtime] ERROR ${msg}`);
    process.exit(1);
}

function ok(msg) {
    console.log(`[validate-runtime] OK ${msg}`);
}

const expressPkg = path.join(root, "node_modules", "express", "package.json");
if (!fs.existsSync(expressPkg)) {
    fail(`express package missing at ${expressPkg}`);
}
ok(`express package.json present`);

try {
    const expressMain = require.resolve("express", { paths: [root] });
    if (!fs.existsSync(expressMain)) {
        fail(`express main missing: ${expressMain}`);
    }
    ok(`express resolves to ${expressMain}`);
} catch (err) {
    fail(`express resolve failed: ${err instanceof Error ? err.message : err}`);
}

const distEntry = path.join(root, "dist", "index.js");
if (!fs.existsSync(distEntry)) {
    fail(`dist/index.js missing — run build before restart`);
}
ok(`dist/index.js present`);

// Soft check: ESM import of express works from this Node.
try {
    await import(pathToFileURL(path.join(root, "node_modules/express/index.js")).href);
    ok("express ESM import succeeded");
} catch (err) {
    fail(`express ESM import failed: ${err instanceof Error ? err.message : err}`);
}

console.log("[validate-runtime] READY");

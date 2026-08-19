import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware.js";
import { apiResponse } from "../../utils/helpers.js";

const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeZip(raw: string): string {
    return String(raw || "").replace(/\D/g, "").slice(0, 5);
}

export async function lookupUsZip(zip: string) {
    const code = normalizeZip(zip);
    if (!/^\d{5}$/.test(code)) return null;
    const hit = cache.get(code);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

    const res = await fetch(`https://api.zippopotam.us/us/${code}`);
    if (res.status === 404) {
        cache.set(code, { at: Date.now(), data: null });
        return null;
    }
    if (!res.ok) {
        throw Object.assign(new Error("ZIP lookup failed"), { status: 502 });
    }
    const json = (await res.json()) as {
        "post code"?: string;
        country?: string;
        places?: Array<Record<string, string>>;
    };
    const places = (json.places || []).map((p) => ({
        city: p["place name"] || "",
        state: p["state abbreviation"] || "",
        stateName: p.state || "",
        latitude: p.latitude || "",
        longitude: p.longitude || "",
    }));
    const data = {
        zip: json["post code"] || code,
        country: json.country || "United States",
        city: places[0]?.city || "",
        state: places[0]?.state || "",
        stateName: places[0]?.stateName || "",
        places,
    };
    cache.set(code, { at: Date.now(), data });
    return data;
}

export const geoRouter = Router();
geoRouter.use(authMiddleware);
geoRouter.get("/zip/:zip", async (req, res) => {
    try {
        const data = await lookupUsZip(String(req.params.zip || ""));
        if (!data) {
            return res.status(404).json(apiResponse(false, "ZIP not found"));
        }
        res.json(apiResponse(true, "OK", data));
    } catch (err) {
        res.status(502).json(
            apiResponse(false, err instanceof Error ? err.message : "ZIP lookup failed")
        );
    }
});

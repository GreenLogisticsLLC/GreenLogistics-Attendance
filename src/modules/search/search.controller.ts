import type { Response } from "express";
import type { AuthRequest } from "../../middlewares/auth.middleware.js";
import { apiResponse } from "../../utils/helpers.js";
import { globalSearchService } from "./global-search.service.js";

export async function globalSearchController(req: AuthRequest, res: Response) {
    try {
        const userId = req.user?.userId;
        const role = req.user?.role;
        if (!userId || !role) {
            return res.status(401).json(apiResponse(false, "Unauthorized"));
        }

        const query = String(req.query.q ?? req.query.query ?? "").trim();
        if (!query) {
            return res.json(
                apiResponse(true, "OK", { query: "", total: 0, groups: [] })
            );
        }

        const limitRaw = Number(req.query.limit || 8);
        const limitPerGroup = Number.isFinite(limitRaw) ? limitRaw : 8;
        const data = await globalSearchService.search(
            { userId, role },
            query,
            limitPerGroup
        );
        return res.json(apiResponse(true, "OK", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Search failed";
        console.warn("[GLOBAL_SEARCH]", message);
        return res.status(500).json(apiResponse(false, message));
    }
}

import { Request, Response } from "express";
import { cardRegistrationService } from "../services/card-registration.service.js";
import { apiResponse, normalizeCardToken } from "../utils/helpers.js";

export async function listPendingCardScansController(_req: Request, res: Response) {
    const scans = await cardRegistrationService.listPending();
    return res.json(apiResponse(true, "Pending card scans loaded", scans));
}

export async function pollCardScanController(req: Request, res: Response) {
    const sinceParam = req.query.since as string | undefined;
    const since = sinceParam ? new Date(sinceParam) : undefined;
    const scan = await cardRegistrationService.getLatestPending(since);
    return res.json(apiResponse(true, scan ? "Card detected" : "Waiting for scan", scan));
}

/** Save a card UID manually (NFC app, Legacy admin panel, etc.) when office readers are offline. */
export async function registerCardUidController(req: Request, res: Response) {
    const raw = String(req.body?.token ?? req.body?.cardUid ?? "").trim();
    const normalized = normalizeCardToken(raw);
    if (!normalized) {
        return res.status(422).json(apiResponse(false, "Enter a card UID"));
    }

    await cardRegistrationService.recordUnknownScan(
        normalized,
        String(req.body?.deviceId ?? "manual-entry"),
        new Date()
    );

    return res.json(
        apiResponse(true, "UID saved — register employee using the form below", {
            cardToken: normalized,
        })
    );
}

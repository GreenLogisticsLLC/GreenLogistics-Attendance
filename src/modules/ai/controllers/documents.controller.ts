import type { Response } from "express";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { apiResponse } from "../../../utils/helpers.js";
import { documentAiJobService } from "../documents/job.service.js";

function actor(req: AuthRequest) {
    const userId = req.user?.userId;
    const role = req.user?.role;
    if (!userId || !role) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return { userId, role };
}

export async function processDocumentController(req: AuthRequest, res: Response) {
    try {
        const documentSource = String(req.body?.documentSource || "").toUpperCase();
        const documentId = String(req.body?.documentId || req.body?.carrierDocumentId || req.body?.loadDocumentId || "");
        if (documentSource !== "CARRIER" && documentSource !== "LOAD") {
            return res.status(422).json(apiResponse(false, "documentSource must be CARRIER or LOAD"));
        }
        const data = await documentAiJobService.enqueue({
            actor: actor(req),
            documentSource,
            documentId,
        });
        return res.status(202).json(apiResponse(true, "Document AI job queued", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to queue document job";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export async function getDocumentJobController(req: AuthRequest, res: Response) {
    try {
        const jobId = String(req.params.jobId || "");
        const data = await documentAiJobService.getJob(actor(req), jobId);
        return res.json(apiResponse(true, "OK", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Job fetch failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export async function getDocumentValidationController(req: AuthRequest, res: Response) {
    try {
        const documentId = String(req.params.documentId || "");
        const data = await documentAiJobService.getLatestForDocument(actor(req), documentId);
        if (!data) return res.status(404).json(apiResponse(false, "No validation found for document"));
        return res.json(apiResponse(true, "OK", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Validation fetch failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

export async function reviewDocumentJobController(req: AuthRequest, res: Response) {
    try {
        const jobId = String(req.params.jobId || "");
        const data = await documentAiJobService.submitReview(actor(req), jobId, {
            decision: String(req.body?.decision || ""),
            notes: req.body?.notes != null ? String(req.body.notes) : undefined,
        });
        return res.json(apiResponse(true, "Review recorded (master data unchanged)", data));
    } catch (err) {
        const message = err instanceof Error ? err.message : "Review failed";
        const status =
            err && typeof err === "object" && "status" in err
                ? Number((err as { status: number }).status)
                : 500;
        return res.status(status || 500).json(apiResponse(false, message));
    }
}

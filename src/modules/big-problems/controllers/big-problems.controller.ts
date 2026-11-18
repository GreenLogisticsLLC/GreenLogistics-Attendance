import fs from "fs";
import os from "os";
import path from "path";
import type { RequestHandler, Response } from "express";
import multer from "multer";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { bigProblemsService } from "../services/big-problems.service.js";
import type { BpActor } from "../permissions.js";

const uploadTmp = multer({
    dest: path.join(os.tmpdir(), "greenos-bp-uploads"),
    limits: { fileSize: 25 * 1024 * 1024 },
});
fs.mkdirSync(path.join(os.tmpdir(), "greenos-bp-uploads"), { recursive: true });

export const bpUploadMiddleware: RequestHandler = uploadTmp.single("file");

function actor(req: AuthRequest): BpActor {
    return { userId: req.user!.userId, role: req.user!.role };
}

function handleError(res: Response, err: unknown) {
    const e = err as { status?: number; message?: string };
    const status = e.status || 500;
    return res.status(status).json(apiResponse(false, e.message || "Big Problems error"));
}

export async function bpMetaController(req: AuthRequest, res: Response) {
    try {
        return res.json(
            apiResponse(true, "Meta", {
                ...bigProblemsService.meta(),
                users: await bigProblemsService.listAssignableUsers(),
            })
        );
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpOverviewController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.overview(actor(req));
        return res.json(apiResponse(true, "Overview loaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpListCasesController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.listCases(actor(req), {
            q: typeof req.query.q === "string" ? req.query.q : undefined,
            status: typeof req.query.status === "string" ? req.query.status : undefined,
            severity: typeof req.query.severity === "string" ? req.query.severity : undefined,
            category: typeof req.query.category === "string" ? req.query.category : undefined,
            closed: typeof req.query.closed === "string" ? req.query.closed : undefined,
            page: req.query.page ? Number(req.query.page) : undefined,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
            sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
            sortDir: typeof req.query.sortDir === "string" ? req.query.sortDir : undefined,
        });
        return res.json(apiResponse(true, "Cases loaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpGetCaseController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.getCase(actor(req), String(req.params.id));
        return res.json(apiResponse(true, "Case loaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpCreateCaseController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.createCase(actor(req), req.body || {});
        return res.status(201).json(apiResponse(true, "Case created", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpUpdateCaseController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.updateCase(actor(req), String(req.params.id), req.body || {});
        return res.json(apiResponse(true, "Case updated", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpCloseCaseController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.closeCase(
            actor(req),
            String(req.params.id),
            req.body?.resolutionSummary
        );
        return res.json(apiResponse(true, "Case closed", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpReopenCaseController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.reopenCase(actor(req), String(req.params.id));
        return res.json(apiResponse(true, "Case reopened", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpUpdateFinancialsController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.updateFinancials(
            actor(req),
            String(req.params.id),
            req.body || {}
        );
        return res.json(apiResponse(true, "Financials updated", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpCreateTaskController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.createTask(actor(req), String(req.params.id), req.body || {});
        return res.status(201).json(apiResponse(true, "Task created", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpUpdateTaskController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.updateTask(
            actor(req),
            String(req.params.taskId),
            req.body || {}
        );
        return res.json(apiResponse(true, "Task updated", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpAddTaskCommentController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.addTaskComment(
            actor(req),
            String(req.params.taskId),
            req.body?.body || req.body?.comment || ""
        );
        return res.status(201).json(apiResponse(true, "Comment added", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpMyTasksController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.myTasks(actor(req));
        return res.json(apiResponse(true, "My tasks loaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpDeadlinesController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.deadlines(actor(req));
        return res.json(apiResponse(true, "Deadlines loaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpFinancialExposureController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.financialExposure(actor(req));
        return res.json(apiResponse(true, "Financial exposure loaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpAddCommunicationController(req: AuthRequest, res: Response) {
    try {
        const data = await bigProblemsService.addCommunication(
            actor(req),
            String(req.params.id),
            req.body || {}
        );
        return res.status(201).json(apiResponse(true, "Communication added", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpUploadDocumentController(req: AuthRequest, res: Response) {
    try {
        const file = req.file;
        if (!file) return res.status(422).json(apiResponse(false, "Choose a file to upload"));
        const data = await bigProblemsService.uploadDocument(
            actor(req),
            String(req.params.id),
            {
                originalName: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
                tempPath: file.path,
            },
            typeof req.body?.docKind === "string" ? req.body.docKind : undefined
        );
        return res.status(201).json(apiResponse(true, "Document uploaded", data));
    } catch (err) {
        return handleError(res, err);
    }
}

export async function bpDownloadDocumentController(req: AuthRequest, res: Response) {
    try {
        const doc = await bigProblemsService.resolveDocumentDownload(
            actor(req),
            String(req.params.documentId)
        );
        res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(doc.fileName)}"`
        );
        return fs.createReadStream(doc.storagePath).pipe(res);
    } catch (err) {
        return handleError(res, err);
    }
}

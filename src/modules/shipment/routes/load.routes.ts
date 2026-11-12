import { Router } from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import { loadController } from "../controllers/load.controller.js";
import { loadTrackingRouter } from "../../tracking/routes/tracking.routes.js";

export const loadRouter = Router();

const roles = requireRole(
    Roles.Administrator,
    Roles.Owner,
    Roles.Manager,
    Roles.TeamLead,
    Roles.Broker,
    Roles.Accounting,
    Roles.Dispatcher
);

const podUploadDir = path.join(os.tmpdir(), "greenos-pod-uploads");
fs.mkdirSync(podUploadDir, { recursive: true });
/** Keep in sync with nginx client_max_body_size (tools/nginx/greenos-upload-size.conf). */
export const LOAD_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const podUpload = multer({
    dest: podUploadDir,
    limits: { fileSize: LOAD_UPLOAD_MAX_BYTES },
});

/** Always return JSON for multer failures (HTML error pages become "Bad response" in the UI). */
function podUploadSingle(
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction
) {
    podUpload.single("file")(req, res, (err: unknown) => {
        if (!err) return next();
        const multerErr = err as { code?: string; message?: string; name?: string };
        const tooLarge = multerErr.code === "LIMIT_FILE_SIZE";
        return res.status(tooLarge ? 413 : 400).json({
            success: false,
            message: tooLarge
                ? "File is too large (max 50 MB). Compress the PDF or use a smaller scan, then try again."
                : multerErr.message || "File upload failed",
            code: multerErr.code || multerErr.name || "UPLOAD_ERROR",
        });
    });
}

function isDocumentUploadPath(req: import("express").Request): boolean {
    return (
        req.method === "POST" &&
        /\/documents\/[^/]+\/upload\/?$/.test(String(req.path || ""))
    );
}

/**
 * Auth normally runs first. For multipart document uploads, multer must run first
 * so FormData `sessionToken` is available when the Authorization header is missing.
 */
loadRouter.use((req, res, next) => {
    if (isDocumentUploadPath(req)) return next();
    return authMiddleware(req, res, next);
});

loadRouter.get("/", roles, (req, res) => loadController.list(req, res));
loadRouter.use("/:id/tracking", roles, loadTrackingRouter);
loadRouter.get("/:id", roles, (req, res) => loadController.get(req, res));
loadRouter.delete("/:id", roles, (req, res) => loadController.remove(req, res));
loadRouter.post("/:id/create", roles, (req, res) => loadController.create(req, res));
loadRouter.post("/:id/customer-setup", roles, (req, res) =>
    loadController.customerSetup(req, res)
);
loadRouter.post("/:id/void", roles, (req, res) => loadController.voidLoad(req, res));
loadRouter.post("/:id/unvoid", roles, (req, res) => loadController.unvoidLoad(req, res));
loadRouter.patch("/:id", roles, (req, res) => loadController.update(req, res));
loadRouter.post("/:id/actions/:action", roles, (req, res) => loadController.action(req, res));

loadRouter.get("/:id/documents", roles, (req, res) => loadController.listDocuments(req, res));
loadRouter.get("/:id/documents/history/:docType", roles, (req, res) =>
    loadController.documentHistory(req, res)
);
loadRouter.post(
    "/:id/documents/POD/upload",
    podUploadSingle,
    authMiddleware,
    roles,
    (req, res) => loadController.uploadPod(req, res)
);
loadRouter.post(
    "/:id/documents/:docType/upload",
    podUploadSingle,
    authMiddleware,
    roles,
    (req, res) => loadController.uploadPaymentProof(req, res)
);
loadRouter.post("/:id/documents/:docType/generate", roles, (req, res) =>
    loadController.generateDocument(req, res)
);
loadRouter.post("/:id/documents/:docType/edit", roles, (req, res) =>
    loadController.editDocument(req, res)
);
loadRouter.get("/:id/documents/:documentId/download", roles, (req, res) =>
    loadController.downloadDocument(req, res)
);
loadRouter.post("/:id/documents/:documentId/archive", roles, (req, res) =>
    loadController.archiveDocument(req, res)
);
loadRouter.post("/:id/documents/:documentId/sent", roles, (req, res) =>
    loadController.markDocumentSent(req, res)
);

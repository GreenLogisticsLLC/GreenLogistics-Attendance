import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import { aiChatController, aiStatusController } from "../controllers/ai.controller.js";
import {
    getDocumentJobController,
    getDocumentValidationController,
    processDocumentController,
    reviewDocumentJobController,
} from "../controllers/documents.controller.js";

export const aiRouter = Router();

aiRouter.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});
aiRouter.use(authMiddleware);

const aiRoles = requireRole(
    Roles.Administrator,
    Roles.Owner,
    Roles.Manager,
    Roles.TeamLead,
    Roles.Broker,
    Roles.Dispatcher,
    Roles.HR,
    Roles.Accounting,
    Roles.Viewer
);

aiRouter.get("/status", aiRoles, aiStatusController);
aiRouter.post("/chat", aiRoles, aiChatController);
aiRouter.post("/documents/process", aiRoles, processDocumentController);
aiRouter.get("/documents/jobs/:jobId", aiRoles, getDocumentJobController);
aiRouter.get("/documents/:documentId/validation", aiRoles, getDocumentValidationController);
aiRouter.post("/documents/jobs/:jobId/review", aiRoles, reviewDocumentJobController);

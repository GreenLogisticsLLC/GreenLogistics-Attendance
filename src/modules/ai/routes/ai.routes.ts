import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import {
    aiCarrierSummaryController,
    aiChatController,
    aiSearchController,
    aiShipmentSummaryController,
    aiStatusController,
} from "../controllers/ai.controller.js";
import { marketRateQuoteController } from "../rates/rates.controller.js";
import {
    getDocumentJobController,
    getDocumentValidationController,
    processDocumentController,
    reviewDocumentJobController,
} from "../controllers/documents.controller.js";
import {
    cancelAiActionController,
    confirmAiActionController,
    getAiActionController,
    proposeAiActionController,
} from "../actions/actions.controller.js";

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
aiRouter.post("/search", aiRoles, aiSearchController);
aiRouter.get("/carriers/:id/summary", aiRoles, aiCarrierSummaryController);
aiRouter.get("/shipments/:id/summary", aiRoles, aiShipmentSummaryController);
aiRouter.post("/rates/quote", aiRoles, marketRateQuoteController);
aiRouter.post("/documents/process", aiRoles, processDocumentController);
aiRouter.get("/documents/jobs/:jobId", aiRoles, getDocumentJobController);
aiRouter.get("/documents/:documentId/validation", aiRoles, getDocumentValidationController);
aiRouter.post("/documents/jobs/:jobId/review", aiRoles, reviewDocumentJobController);

aiRouter.post("/actions/propose", aiRoles, proposeAiActionController);
aiRouter.post("/actions/preview", aiRoles, proposeAiActionController);
aiRouter.get("/actions/:actionId", aiRoles, getAiActionController);
aiRouter.post("/actions/:actionId/confirm", aiRoles, confirmAiActionController);
aiRouter.post("/actions/:actionId/cancel", aiRoles, cancelAiActionController);

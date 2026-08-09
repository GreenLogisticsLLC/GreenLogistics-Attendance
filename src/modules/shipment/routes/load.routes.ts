import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import { loadController } from "../controllers/load.controller.js";
import { loadTrackingRouter } from "../../tracking/routes/tracking.routes.js";

export const loadRouter = Router();

loadRouter.use(authMiddleware);

const roles = requireRole(
    Roles.Administrator,
    Roles.Owner,
    Roles.Manager,
    Roles.TeamLead,
    Roles.Broker,
    Roles.Accounting,
    Roles.Dispatcher
);

loadRouter.get("/", roles, (req, res) => loadController.list(req, res));
loadRouter.use("/:id/tracking", roles, loadTrackingRouter);
loadRouter.get("/:id", roles, (req, res) => loadController.get(req, res));
loadRouter.post("/:id/create", roles, (req, res) => loadController.create(req, res));
loadRouter.patch("/:id", roles, (req, res) => loadController.update(req, res));
loadRouter.post("/:id/actions/:action", roles, (req, res) => loadController.action(req, res));

loadRouter.get("/:id/documents", roles, (req, res) => loadController.listDocuments(req, res));
loadRouter.get("/:id/documents/history/:docType", roles, (req, res) =>
    loadController.documentHistory(req, res)
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

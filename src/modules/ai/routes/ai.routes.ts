import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import { aiChatController, aiStatusController } from "../controllers/ai.controller.js";

export const aiRouter = Router();

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

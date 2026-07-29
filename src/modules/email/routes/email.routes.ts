import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import {
    brokerGmailAuthController,
    brokerGmailDisconnectController,
    brokerGmailMessagesController,
    brokerGmailStatusController,
    brokerGmailSyncController,
    checkEmailController,
    emailStatusController,
    getShipmentController,
    gmailAuthController,
    gmailCallbackController,
    listBrokerGmailAccountsController,
    listEmailLogsController,
    listShipmentsController,
} from "../controllers/email.controller.js";

export const emailRouter = Router();

// OAuth must be public — Google redirects here without a JWT.
emailRouter.get("/auth", gmailAuthController);
emailRouter.get("/callback", gmailCallbackController);

emailRouter.use(authMiddleware);

emailRouter.get("/status", emailStatusController);
emailRouter.get("/shipments", listShipmentsController);
emailRouter.get("/shipments/:id", getShipmentController);
emailRouter.post(
    "/check",
    requireRole("Administrator", "Owner", "Manager", "Broker", Roles.TeamLead),
    checkEmailController
);
emailRouter.get(
    "/logs",
    requireRole("Administrator", "Owner", "Manager", "Broker", Roles.TeamLead),
    listEmailLogsController
);

// Sprint C — per-broker Gmail (self-service: Brokers only)
emailRouter.get("/broker/auth", requireRole(Roles.Broker), brokerGmailAuthController);
emailRouter.get("/broker/status", requireRole(Roles.Broker), brokerGmailStatusController);
emailRouter.post("/broker/disconnect", requireRole(Roles.Broker), brokerGmailDisconnectController);
emailRouter.post("/broker/sync", requireRole(Roles.Broker), brokerGmailSyncController);
emailRouter.get("/broker/messages", requireRole(Roles.Broker), brokerGmailMessagesController);
emailRouter.get(
    "/broker/accounts",
    requireRole("Administrator", "Owner", "Manager", Roles.TeamLead),
    listBrokerGmailAccountsController
);

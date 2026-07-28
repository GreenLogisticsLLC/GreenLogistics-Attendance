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

// Sprint C — per-broker Gmail
emailRouter.get("/broker/auth", brokerGmailAuthController);
emailRouter.get("/broker/status", brokerGmailStatusController);
emailRouter.post("/broker/disconnect", brokerGmailDisconnectController);
emailRouter.post("/broker/sync", brokerGmailSyncController);
emailRouter.get("/broker/messages", brokerGmailMessagesController);
emailRouter.get(
    "/broker/accounts",
    requireRole("Administrator", "Owner", "Manager", Roles.TeamLead),
    listBrokerGmailAccountsController
);

import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import {
    crmAcceptShipmentController,
    crmBrokerWorkspaceController,
    crmCustomerDetailController,
    crmDashboardController,
    crmDeleteShipmentFileController,
    crmDownloadShipmentFileController,
    crmGetShipmentController,
    crmListBrokersController,
    crmListShipmentsController,
    crmMarkShipmentOpenedController,
    crmMarkAllNotificationsReadController,
    crmMarkNotificationReadController,
    crmMyCustomersController,
    crmMyNotificationsController,
    crmUpdateShipmentController,
    crmUploadMiddleware,
    crmUploadShipmentFileController,
} from "../controllers/crm.controller.js";
import { crmEventsSseController } from "../controllers/crm-events.controller.js";

export const crmRouter = Router();

// SSE: EventSource cannot set Authorization — auth via ?token= inside controller
crmRouter.get("/events", crmEventsSseController);

crmRouter.use(authMiddleware);

const crmRoles = requireRole(
    Roles.Administrator,
    Roles.Owner,
    Roles.Manager,
    Roles.TeamLead,
    Roles.Broker,
    Roles.Accounting,
    Roles.Dispatcher
);

crmRouter.get("/dashboard", crmRoles, crmDashboardController);
crmRouter.get("/shipments", crmRoles, crmListShipmentsController);
crmRouter.get("/shipments/:id", crmRoles, crmGetShipmentController);
crmRouter.post("/shipments/:id/opened", crmRoles, crmMarkShipmentOpenedController);
crmRouter.patch("/shipments/:id", crmRoles, crmUpdateShipmentController);
crmRouter.post("/shipments/:id/accept", crmRoles, crmAcceptShipmentController);
crmRouter.post(
    "/shipments/:id/files",
    crmRoles,
    crmUploadMiddleware,
    crmUploadShipmentFileController
);
crmRouter.get("/shipments/:id/files/:fileId", crmRoles, crmDownloadShipmentFileController);
crmRouter.delete("/shipments/:id/files/:fileId", crmRoles, crmDeleteShipmentFileController);
crmRouter.get("/brokers", crmRoles, crmListBrokersController);
crmRouter.get("/brokers/:id", crmRoles, crmBrokerWorkspaceController);
crmRouter.get("/customers", crmRoles, crmMyCustomersController);
crmRouter.get("/customers/:name", crmRoles, crmCustomerDetailController);
crmRouter.get("/notifications", crmRoles, crmMyNotificationsController);
crmRouter.post("/notifications/read-all", crmRoles, crmMarkAllNotificationsReadController);
crmRouter.post("/notifications/:id/read", crmRoles, crmMarkNotificationReadController);

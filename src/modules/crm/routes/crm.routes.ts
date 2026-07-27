import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import {
    crmAcceptShipmentController,
    crmBrokerWorkspaceController,
    crmDashboardController,
    crmGetShipmentController,
    crmListBrokersController,
    crmListShipmentsController,
    crmUpdateShipmentController,
} from "../controllers/crm.controller.js";

export const crmRouter = Router();

crmRouter.use(authMiddleware);

const crmRoles = requireRole(
    "Administrator",
    "Owner",
    "Manager",
    "Broker",
    "Accounting"
);

crmRouter.get("/dashboard", crmRoles, crmDashboardController);
crmRouter.get("/shipments", crmRoles, crmListShipmentsController);
crmRouter.get("/shipments/:id", crmRoles, crmGetShipmentController);
crmRouter.patch("/shipments/:id", crmRoles, crmUpdateShipmentController);
crmRouter.post("/shipments/:id/accept", crmRoles, crmAcceptShipmentController);
crmRouter.get("/brokers", crmRoles, crmListBrokersController);
crmRouter.get("/brokers/:id", crmRoles, crmBrokerWorkspaceController);

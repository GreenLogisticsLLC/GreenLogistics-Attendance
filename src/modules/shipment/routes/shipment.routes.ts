import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import { shipmentController } from "../controllers/shipment.controller.js";

export const shipmentRouter = Router();

shipmentRouter.use(authMiddleware);

const roles = requireRole(
    Roles.Administrator,
    Roles.Owner,
    Roles.Manager,
    Roles.TeamLead,
    Roles.Broker,
    Roles.Accounting,
    Roles.Dispatcher
);

shipmentRouter.get("/:id", roles, (req, res) => shipmentController.getCard(req, res));
shipmentRouter.post("/:id/load-number", roles, (req, res) =>
    shipmentController.applyLoadNumber(req, res)
);
shipmentRouter.patch("/:id/operations", roles, (req, res) =>
    shipmentController.updateOperations(req, res)
);
shipmentRouter.get("/:id/events", roles, (req, res) => shipmentController.listEvents(req, res));

import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import {
    checkEmailController,
    emailStatusController,
    getShipmentController,
    listEmailLogsController,
    listShipmentsController,
} from "../controllers/email.controller.js";

export const emailRouter = Router();

emailRouter.use(authMiddleware);

emailRouter.get("/status", emailStatusController);
emailRouter.get("/shipments", listShipmentsController);
emailRouter.get("/shipments/:id", getShipmentController);
emailRouter.post(
    "/check",
    requireRole("Administrator", "Owner", "Manager", "Broker"),
    checkEmailController
);
emailRouter.get(
    "/logs",
    requireRole("Administrator", "Owner", "Manager", "Broker"),
    listEmailLogsController
);

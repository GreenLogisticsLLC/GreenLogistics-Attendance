import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import {
    assignmentEligibleController,
    assignmentLogsController,
    assignmentQueueStatusController,
    linkEmployeeController,
    setAvailableController,
} from "../controllers/assignment.controller.js";

export const assignmentRouter = Router();

assignmentRouter.use(authMiddleware);

const roles = requireRole("Administrator", "Owner", "Manager", "Broker");

assignmentRouter.get("/queue", roles, assignmentQueueStatusController);
assignmentRouter.get("/eligible", roles, assignmentEligibleController);
assignmentRouter.get("/logs", roles, assignmentLogsController);
assignmentRouter.patch(
    "/users/:userId/available",
    requireRole("Administrator", "Owner", "Manager"),
    setAvailableController
);
assignmentRouter.patch(
    "/users/:userId/employee",
    requireRole("Administrator", "Owner", "Manager"),
    linkEmployeeController
);

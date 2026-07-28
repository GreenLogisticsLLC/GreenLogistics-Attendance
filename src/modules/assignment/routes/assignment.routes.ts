import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import {
    assignmentEligibleController,
    assignmentLogsController,
    assignmentQueueStatusController,
    assignmentDrainPendingController,
    linkEmployeeController,
} from "../controllers/assignment.controller.js";

export const assignmentRouter = Router();

assignmentRouter.use(authMiddleware);

const roles = requireRole("Administrator", "Owner", "Manager", "Broker");

assignmentRouter.get("/queue", roles, assignmentQueueStatusController);
assignmentRouter.get("/eligible", roles, assignmentEligibleController);
assignmentRouter.get("/logs", roles, assignmentLogsController);
assignmentRouter.post(
    "/drain-pending",
    requireRole("Administrator", "Owner", "Manager"),
    assignmentDrainPendingController
);
assignmentRouter.patch(
    "/users/:userId/employee",
    requireRole("Administrator", "Owner", "Manager"),
    linkEmployeeController
);

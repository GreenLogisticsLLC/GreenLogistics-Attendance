import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { customerController } from "../controllers/customer.controller.js";

const staff = ["Administrator", "Owner", "Manager", "Team Lead", "Broker", "Dispatcher"] as const;

export const customerRouter = Router();
customerRouter.use(authMiddleware);
customerRouter.get("/", requireRole(...staff), customerController.list);
customerRouter.post("/", requireRole(...staff), customerController.create);
customerRouter.get("/:id", requireRole(...staff), customerController.get);
customerRouter.patch("/:id", requireRole(...staff), customerController.update);
customerRouter.post("/:id/loads", requireRole(...staff), customerController.createLoad);

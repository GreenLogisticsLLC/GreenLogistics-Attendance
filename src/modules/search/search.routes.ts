import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware.js";
import { globalSearchController } from "./search.controller.js";

export const searchRouter = Router();

searchRouter.get("/", authMiddleware, globalSearchController);

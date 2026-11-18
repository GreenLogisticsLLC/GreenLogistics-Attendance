import { Router } from "express";
import { authMiddleware, requireRole } from "../../../middlewares/auth.middleware.js";
import { Roles } from "../../../auth/roles.js";
import {
    bpAddCommunicationController,
    bpAddTaskCommentController,
    bpCloseCaseController,
    bpCreateCaseController,
    bpCreateTaskController,
    bpDeadlinesController,
    bpDeleteCaseController,
    bpDownloadDocumentController,
    bpFinancialExposureController,
    bpGetCaseController,
    bpListCasesController,
    bpMetaController,
    bpMyTasksController,
    bpOverviewController,
    bpReopenCaseController,
    bpUpdateCaseController,
    bpUpdateFinancialsController,
    bpUpdateTaskController,
    bpUploadDocumentController,
    bpUploadMiddleware,
} from "../controllers/big-problems.controller.js";

export const bigProblemsRouter = Router();

const bpRoles = requireRole(
    Roles.Administrator,
    Roles.Owner,
    Roles.Manager,
    Roles.TeamLead,
    Roles.Broker,
    Roles.Accounting
);

bigProblemsRouter.use(authMiddleware);

bigProblemsRouter.get("/meta", bpRoles, bpMetaController);
bigProblemsRouter.get("/overview", bpRoles, bpOverviewController);
bigProblemsRouter.get("/cases", bpRoles, bpListCasesController);
bigProblemsRouter.post("/cases", bpRoles, bpCreateCaseController);
bigProblemsRouter.get("/cases/:id", bpRoles, bpGetCaseController);
bigProblemsRouter.patch("/cases/:id", bpRoles, bpUpdateCaseController);
bigProblemsRouter.post("/cases/:id/close", bpRoles, bpCloseCaseController);
bigProblemsRouter.post("/cases/:id/reopen", bpRoles, bpReopenCaseController);
bigProblemsRouter.delete("/cases/:id", bpRoles, bpDeleteCaseController);
bigProblemsRouter.put("/cases/:id/financials", bpRoles, bpUpdateFinancialsController);
bigProblemsRouter.post("/cases/:id/tasks", bpRoles, bpCreateTaskController);
bigProblemsRouter.post("/cases/:id/communications", bpRoles, bpAddCommunicationController);
bigProblemsRouter.post(
    "/cases/:id/documents",
    bpRoles,
    bpUploadMiddleware,
    bpUploadDocumentController
);

bigProblemsRouter.patch("/tasks/:taskId", bpRoles, bpUpdateTaskController);
bigProblemsRouter.post("/tasks/:taskId/comments", bpRoles, bpAddTaskCommentController);

bigProblemsRouter.get("/my-tasks", bpRoles, bpMyTasksController);
bigProblemsRouter.get("/deadlines", bpRoles, bpDeadlinesController);
bigProblemsRouter.get("/financial-exposure", bpRoles, bpFinancialExposureController);
bigProblemsRouter.get("/documents/:documentId/download", bpRoles, bpDownloadDocumentController);

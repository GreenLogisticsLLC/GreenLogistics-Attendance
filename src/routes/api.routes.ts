import { Router } from "express";
import { loginController, registerController, approveRegistrationController, rejectRegistrationController, meController } from "../controllers/auth.controller.js";
import {
    getDashboardController,
    getEmployeeDetailController,
} from "../controllers/dashboard.controller.js";
import {
    legacyWebhookController,
    standardWebhookController,
    testWebhookController,
} from "../controllers/webhook.controller.js";
import {
    listEmployeesController,
    createEmployeeController,
    updateEmployeeController,
    deleteEmployeeController,
    deactivateEmployeeController,
    markEmployeeLeftController,
    testEmployeeScanController,
    syncEmployeeController,
    syncAllEmployeesController,
    getSettingsController,
    updateSettingsController,
    testLegacyConnectionController,
    listShiftsController,
    dailyReportController,
    healthController,
    listNotificationsController,
    listWebhookLogsController,
    networkInfoController,
} from "../controllers/admin.controller.js";
import {
    listPendingCardScansController,
    pollCardScanController,
    registerCardUidController,
} from "../controllers/card-registration.controller.js";
import {
    periodReportController,
    periodReportPdfController,
} from "../controllers/report.controller.js";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware.js";
import {
    listUsersController,
    listAssignableRolesController,
    updateUserRoleController,
    deleteUserController,
} from "../controllers/users.controller.js";
import { emailRouter } from "../modules/email/routes/email.routes.js";
import { crmRouter } from "../modules/crm/routes/crm.routes.js";
import { shipmentRouter } from "../modules/shipment/routes/shipment.routes.js";
import { assignmentRouter } from "../modules/assignment/routes/assignment.routes.js";
import { aiRouter } from "../modules/ai/routes/ai.routes.js";

export const apiRouter = Router();

apiRouter.get("/health", healthController);
apiRouter.get("/v1/network-info", networkInfoController);

apiRouter.use("/email", emailRouter);
apiRouter.use("/crm", crmRouter);
apiRouter.use("/shipments", shipmentRouter);
apiRouter.use("/assignment", assignmentRouter);
apiRouter.use("/ai", aiRouter);

apiRouter.post("/v1/auth/login", loginController);
apiRouter.post("/v1/auth/register", registerController);
apiRouter.get("/v1/auth/registration/approve", approveRegistrationController);
apiRouter.get("/v1/auth/registration/reject", rejectRegistrationController);
apiRouter.get("/v1/auth/me", authMiddleware, meController);

apiRouter.get(
    "/v1/users",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager", "HR"),
    listUsersController
);
apiRouter.get(
    "/v1/roles",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager", "HR"),
    listAssignableRolesController
);
apiRouter.patch(
    "/v1/users/:userId/role",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager", "HR"),
    updateUserRoleController
);
apiRouter.put(
    "/v1/users/:userId/role",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager", "HR"),
    updateUserRoleController
);
apiRouter.delete(
    "/v1/users/:userId",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager", "HR"),
    deleteUserController
);

apiRouter.post("/v1/webhook/attendance", legacyWebhookController);
apiRouter.post("/v1/webhook/standard", standardWebhookController);
apiRouter.post("/v1/webhook/test", authMiddleware, testWebhookController);

apiRouter.get("/v1/dashboard", authMiddleware, getDashboardController);
apiRouter.get("/v1/employees/:employeeId", authMiddleware, getEmployeeDetailController);

apiRouter.get("/v1/employees", authMiddleware, listEmployeesController);
apiRouter.post(
    "/v1/employees",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    createEmployeeController
);
apiRouter.put(
    "/v1/employees/:employeeId",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    updateEmployeeController
);
apiRouter.delete(
    "/v1/employees/:employeeId",
    authMiddleware,
    requireRole("Administrator", "Owner"),
    deleteEmployeeController
);
apiRouter.post(
    "/v1/employees/:employeeId/deactivate",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    deactivateEmployeeController
);
apiRouter.post(
    "/v1/employees/:employeeId/test-scan",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    testEmployeeScanController
);
apiRouter.post(
    "/v1/employees/:employeeId/mark-left",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    markEmployeeLeftController
);
apiRouter.post(
    "/v1/employees/:employeeId/sync",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    syncEmployeeController
);
apiRouter.post(
    "/v1/employees/sync-all",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    syncAllEmployeesController
);

apiRouter.get(
    "/v1/card-registration/pending",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    listPendingCardScansController
);
apiRouter.get(
    "/v1/card-registration/poll",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    pollCardScanController
);
apiRouter.post(
    "/v1/card-registration/register-uid",
    authMiddleware,
    requireRole("Administrator", "Owner", "Manager"),
    registerCardUidController
);

apiRouter.get("/v1/settings", authMiddleware, requireRole("Administrator", "Owner"), getSettingsController);
apiRouter.put(
    "/v1/settings",
    authMiddleware,
    requireRole("Administrator", "Owner"),
    updateSettingsController
);
apiRouter.post(
    "/v1/settings/test-legacy",
    authMiddleware,
    requireRole("Administrator", "Owner"),
    testLegacyConnectionController
);

apiRouter.get("/v1/shifts", authMiddleware, listShiftsController);
apiRouter.get("/v1/reports/daily", authMiddleware, dailyReportController);
apiRouter.get("/v1/reports/period", authMiddleware, periodReportController);
apiRouter.get("/v1/reports/period/pdf", authMiddleware, periodReportPdfController);
apiRouter.get("/v1/notifications", authMiddleware, listNotificationsController);
apiRouter.get(
    "/v1/webhook-logs",
    authMiddleware,
    requireRole("Administrator", "Owner"),
    listWebhookLogsController
);

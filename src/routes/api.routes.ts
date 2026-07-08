import { Router } from "express";
import { loginController, meController } from "../controllers/auth.controller.js";
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

export const apiRouter = Router();

apiRouter.get("/health", healthController);
apiRouter.get("/v1/network-info", networkInfoController);

apiRouter.post("/v1/auth/login", loginController);
apiRouter.get("/v1/auth/me", authMiddleware, meController);

apiRouter.post("/v1/webhook/attendance", legacyWebhookController);
apiRouter.post("/v1/webhook/standard", standardWebhookController);
apiRouter.post("/v1/webhook/test", authMiddleware, testWebhookController);

apiRouter.get("/v1/dashboard", authMiddleware, getDashboardController);
apiRouter.get("/v1/employees/:employeeId", authMiddleware, getEmployeeDetailController);

apiRouter.get("/v1/employees", authMiddleware, listEmployeesController);
apiRouter.post(
    "/v1/employees",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    createEmployeeController
);
apiRouter.put(
    "/v1/employees/:employeeId",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    updateEmployeeController
);
apiRouter.delete(
    "/v1/employees/:employeeId",
    authMiddleware,
    requireRole("Administrator"),
    deleteEmployeeController
);
apiRouter.post(
    "/v1/employees/:employeeId/deactivate",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    deactivateEmployeeController
);
apiRouter.post(
    "/v1/employees/:employeeId/test-scan",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    testEmployeeScanController
);
apiRouter.post(
    "/v1/employees/:employeeId/mark-left",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    markEmployeeLeftController
);
apiRouter.post(
    "/v1/employees/:employeeId/sync",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    syncEmployeeController
);
apiRouter.post(
    "/v1/employees/sync-all",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    syncAllEmployeesController
);

apiRouter.get(
    "/v1/card-registration/pending",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    listPendingCardScansController
);
apiRouter.get(
    "/v1/card-registration/poll",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    pollCardScanController
);
apiRouter.post(
    "/v1/card-registration/register-uid",
    authMiddleware,
    requireRole("Administrator", "Manager"),
    registerCardUidController
);

apiRouter.get("/v1/settings", authMiddleware, requireRole("Administrator"), getSettingsController);
apiRouter.put(
    "/v1/settings",
    authMiddleware,
    requireRole("Administrator"),
    updateSettingsController
);
apiRouter.post(
    "/v1/settings/test-legacy",
    authMiddleware,
    requireRole("Administrator"),
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
    requireRole("Administrator"),
    listWebhookLogsController
);

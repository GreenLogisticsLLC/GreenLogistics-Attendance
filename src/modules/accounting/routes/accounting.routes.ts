import { Router } from "express";
import {
    authMiddleware,
    requireAccountingAccess,
    requireAccountingPermission,
} from "../../../middlewares/auth.middleware.js";
import { AccountingPermissions } from "../../../auth/accounting.js";
import {
    accountingAddNoteController,
    accountingCarrierPaymentController,
    accountingCreateInvoiceController,
    accountingCustomerPaymentController,
    accountingDashboardController,
    accountingGetShipmentController,
    accountingListShipmentsController,
    accountingReadyBillingController,
    accountingReadyCarrierPayController,
    accountingRejectDocumentsController,
    accountingSendInvoiceController,
    accountingVerifyDocumentsController,
    accountingVerifyFinancialsController,
} from "../controllers/accounting.controller.js";

export const accountingRouter = Router();

accountingRouter.use(authMiddleware);
accountingRouter.use(requireAccountingAccess());

accountingRouter.get("/dashboard", accountingDashboardController);
accountingRouter.get(
    "/shipments",
    requireAccountingPermission(AccountingPermissions.ShipmentsView),
    accountingListShipmentsController
);
accountingRouter.get(
    "/shipments/:id",
    requireAccountingPermission(AccountingPermissions.ShipmentsView),
    accountingGetShipmentController
);

accountingRouter.post(
    "/shipments/:id/documents/verify",
    requireAccountingPermission(AccountingPermissions.DocumentsVerify),
    accountingVerifyDocumentsController
);
accountingRouter.post(
    "/shipments/:id/documents/reject",
    requireAccountingPermission(AccountingPermissions.DocumentsReject),
    accountingRejectDocumentsController
);
accountingRouter.post(
    "/shipments/:id/financials/verify",
    requireAccountingPermission(AccountingPermissions.FinancialsVerify),
    accountingVerifyFinancialsController
);
accountingRouter.post(
    "/shipments/:id/ready-for-billing",
    requireAccountingPermission(AccountingPermissions.FinancialsVerify),
    accountingReadyBillingController
);
accountingRouter.post(
    "/shipments/:id/ready-for-carrier-payment",
    requireAccountingPermission(AccountingPermissions.FinancialsVerify),
    accountingReadyCarrierPayController
);
accountingRouter.post(
    "/shipments/:id/notes",
    requireAccountingPermission(AccountingPermissions.NotesCreate),
    accountingAddNoteController
);

accountingRouter.post(
    "/shipments/:id/invoice",
    requireAccountingPermission(AccountingPermissions.BillingCreate),
    accountingCreateInvoiceController
);
accountingRouter.post(
    "/shipments/:id/invoice/send",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingSendInvoiceController
);
accountingRouter.post(
    "/shipments/:id/customer-payment",
    requireAccountingPermission(AccountingPermissions.CustomerPaymentsRecord),
    accountingCustomerPaymentController
);
accountingRouter.post(
    "/carrier-payments/:id",
    requireAccountingPermission(AccountingPermissions.CarrierPaymentsExecute),
    accountingCarrierPaymentController
);
accountingRouter.post(
    "/shipments/:id/carrier-payment",
    requireAccountingPermission(AccountingPermissions.CarrierPaymentsExecute),
    accountingCarrierPaymentController
);

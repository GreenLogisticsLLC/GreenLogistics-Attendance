import { Router } from "express";
import fs from "fs";
import multer from "multer";
import os from "os";
import path from "path";
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
    accountingGetInvoicePricingSettingsController,
    accountingGetShipmentController,
    accountingListShipmentsController,
    accountingPayPalGenerateController,
    accountingPayPalInvoiceCancelController,
    accountingPayPalInvoiceCreateController,
    accountingPayPalInvoicePreviewController,
    accountingPayPalInvoiceRemindController,
    accountingPayPalInvoiceSendController,
    accountingPayPalInvoiceSyncController,
    accountingPayPalSendController,
    accountingPayPalStatusController,
    accountingPreviewInvoicePricingController,
    accountingPreviousCarrierSettlementInvoiceController,
    accountingPreviousCarrierSettlementPaidController,
    accountingReadyBillingController,
    accountingReadyCarrierPayController,
    accountingRejectDocumentsController,
    accountingSendInvoiceController,
    accountingSendCarrierInvoiceController,
    accountingUpdateInvoicePricingSettingsController,
    accountingVerifyDocumentsController,
    accountingVerifyFinancialsController,
} from "../controllers/accounting.controller.js";

export const accountingRouter = Router();

const prevCarrierUploadDir = path.join(os.tmpdir(), "greenos-prev-carrier-invoices");
fs.mkdirSync(prevCarrierUploadDir, { recursive: true });
const prevCarrierUpload = multer({
    dest: prevCarrierUploadDir,
    limits: { fileSize: 25 * 1024 * 1024 },
});

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

accountingRouter.get(
    "/settings/invoice-pricing",
    requireAccountingPermission(AccountingPermissions.BillingView),
    accountingGetInvoicePricingSettingsController
);
accountingRouter.put(
    "/settings/invoice-pricing",
    requireAccountingPermission(AccountingPermissions.PaymentSettingsManage),
    accountingUpdateInvoicePricingSettingsController
);
accountingRouter.get(
    "/shipments/:id/invoice/pricing-preview",
    requireAccountingPermission(AccountingPermissions.BillingView),
    accountingPreviewInvoicePricingController
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
    "/shipments/:id/carrier-invoice/send",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingSendCarrierInvoiceController
);
accountingRouter.post(
    "/shipments/:id/customer-payment",
    requireAccountingPermission(AccountingPermissions.CustomerPaymentsRecord),
    accountingCustomerPaymentController
);

/** PayPal Checkout — amount is server-side from customerPaymentQuote (never from body). */
accountingRouter.post(
    "/shipments/:id/paypal/generate",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalGenerateController
);
accountingRouter.post(
    "/shipments/:id/paypal/status",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalStatusController
);
accountingRouter.post(
    "/shipments/:id/paypal/send",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalSendController
);
/** PayPal Invoicing API v2 (separate from Checkout above). */
accountingRouter.post(
    "/shipments/:id/paypal-invoice/preview",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalInvoicePreviewController
);
accountingRouter.post(
    "/shipments/:id/paypal-invoice/create",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalInvoiceCreateController
);
accountingRouter.post(
    "/shipments/:id/paypal-invoice/send",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalInvoiceSendController
);
accountingRouter.post(
    "/shipments/:id/paypal-invoice/cancel",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalInvoiceCancelController
);
accountingRouter.post(
    "/shipments/:id/paypal-invoice/remind",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalInvoiceRemindController
);
accountingRouter.post(
    "/shipments/:id/paypal-invoice/sync",
    requireAccountingPermission(AccountingPermissions.BillingSend),
    accountingPayPalInvoiceSyncController
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
accountingRouter.post(
    "/previous-carrier-settlements/:settlementId/paid",
    requireAccountingPermission(AccountingPermissions.CarrierPaymentsExecute),
    accountingPreviousCarrierSettlementPaidController
);
accountingRouter.post(
    "/previous-carrier-settlements/:settlementId/invoice",
    prevCarrierUpload.single("file"),
    accountingPreviousCarrierSettlementInvoiceController
);

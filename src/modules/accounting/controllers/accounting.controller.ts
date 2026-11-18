import type { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { accountingService } from "../services/accounting.service.js";
import type { AccountingSubRole } from "../../../auth/accounting.js";

function actorFrom(req: AuthRequest) {
    return {
        userId: req.user!.userId,
        role: req.user!.role,
        accountingSubRole: (req.user!.accountingSubRole || null) as AccountingSubRole | null,
    };
}

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

function errPayload(err: unknown) {
    const message = err instanceof Error ? err.message : "Accounting error";
    const code = (err as { code?: string })?.code;
    return apiResponse(false, message, code ? { code } : undefined);
}

export async function accountingDashboardController(req: AuthRequest, res: Response) {
    try {
        const data = await accountingService.dashboard(actorFrom(req));
        return res.json(apiResponse(true, "Accounting dashboard", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingListShipmentsController(req: AuthRequest, res: Response) {
    try {
        const filter = typeof req.query.filter === "string" ? req.query.filter : "all";
        const data = await accountingService.listShipments(actorFrom(req), filter);
        return res.json(apiResponse(true, "Accounting shipments", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingGetShipmentController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.getShipment(actorFrom(req), id);
        return res.json(apiResponse(true, "Accounting shipment", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingVerifyDocumentsController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const note = typeof req.body?.note === "string" ? req.body.note : undefined;
        const rawSide = String(req.body?.side || "both").toLowerCase();
        const side =
            rawSide === "customer" || rawSide === "carrier" || rawSide === "both"
                ? (rawSide as "customer" | "carrier" | "both")
                : "both";
        const data = await accountingService.verifyDocuments(actorFrom(req), id, note, side);
        return res.json(apiResponse(true, "Documents verified", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingRejectDocumentsController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const reason = String(req.body?.reason || "");
        const needsCorrection = req.body?.needsCorrection !== false;
        const data = await accountingService.rejectDocuments(
            actorFrom(req),
            id,
            reason,
            needsCorrection
        );
        return res.json(apiResponse(true, "Documents rejected", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingVerifyFinancialsController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.verifyFinancials(actorFrom(req), id);
        return res.json(apiResponse(true, "Financials verified", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingReadyBillingController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.markReadyForBilling(actorFrom(req), id);
        return res.json(apiResponse(true, "Ready for billing", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingReadyCarrierPayController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.markReadyForCarrierPayment(actorFrom(req), id);
        return res.json(apiResponse(true, "Ready for carrier payment", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingAddNoteController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const note = String(req.body?.note || "");
        const data = await accountingService.addNote(actorFrom(req), id, note);
        return res.json(apiResponse(true, "Note added", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPreviewInvoicePricingController(
    req: AuthRequest,
    res: Response
) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.previewInvoicePricing(actorFrom(req), id);
        return res.json(apiResponse(true, "Invoice pricing preview", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingCreateInvoiceController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.createInvoice(actorFrom(req), id, {
            invoiceNumber: req.body?.invoiceNumber,
            invoiceDate: req.body?.invoiceDate,
            dueDate: req.body?.dueDate,
            confirmPricing: Boolean(req.body?.confirmPricing),
        });
        return res.json(apiResponse(true, "Invoice created", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingGetInvoicePricingSettingsController(
    req: AuthRequest,
    res: Response
) {
    try {
        const data = await accountingService.getInvoicePricingSettings(actorFrom(req));
        return res.json(apiResponse(true, "Invoice pricing settings", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingUpdateInvoicePricingSettingsController(
    req: AuthRequest,
    res: Response
) {
    try {
        const data = await accountingService.updateInvoicePricingSettings(
            actorFrom(req),
            req.body || {}
        );
        return res.json(apiResponse(true, "Invoice pricing settings saved", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingSendInvoiceController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.sendInvoice(actorFrom(req), id);
        const to = data && typeof data === "object" && "emailTo" in data ? data.emailTo : null;
        return res.json(
            apiResponse(
                true,
                to
                    ? `Invoice emailed to ${to}`
                    : "Invoice emailed to the customer",
                data
            )
        );
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingSendCarrierInvoiceController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.sendCarrierInvoice(actorFrom(req), id);
        return res.json(
            apiResponse(true, "Carrier invoice sent — load moved to Carrier Payments", data)
        );
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingCustomerPaymentController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.recordCustomerPayment(actorFrom(req), id);
        return res.json(apiResponse(true, "Customer payment recorded", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingCarrierPaymentController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const note = typeof req.body?.note === "string" ? req.body.note : undefined;
        const data = await accountingService.executeCarrierPayment(actorFrom(req), id, note);
        return res.json(apiResponse(true, "Carrier payment executed", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingSaveCarrierPaymentDetailsController(
    req: AuthRequest,
    res: Response
) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.saveCarrierPaymentDetails(actorFrom(req), id, {
            carrierRate: req.body?.carrierRate,
            paymentMethod: req.body?.paymentMethod,
            paymentDate: req.body?.paymentDate,
        });
        return res.json(apiResponse(true, "Carrier payment details saved", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingListPreviousCarrierSettlementsController(
    req: AuthRequest,
    res: Response
) {
    try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const data = await accountingService.listPreviousCarrierSettlements(
            actorFrom(req),
            status
        );
        return res.json(apiResponse(true, "Previous carrier settlements", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPreviousCarrierSettlementApproveController(
    req: AuthRequest,
    res: Response
) {
    try {
        const settlementId = String(req.params.settlementId || "");
        const note = typeof req.body?.note === "string" ? req.body.note : undefined;
        const data = await accountingService.approvePreviousCarrierSettlement(
            actorFrom(req),
            settlementId,
            note
        );
        return res.json(apiResponse(true, "Previous carrier settlement approved", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPreviousCarrierSettlementRejectController(
    req: AuthRequest,
    res: Response
) {
    try {
        const settlementId = String(req.params.settlementId || "");
        const comment = String(req.body?.comment || req.body?.note || "");
        const data = await accountingService.rejectPreviousCarrierSettlement(
            actorFrom(req),
            settlementId,
            comment
        );
        return res.json(apiResponse(true, "Previous carrier settlement rejected", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPreviousCarrierSettlementPaidController(
    req: AuthRequest,
    res: Response
) {
    try {
        const settlementId = String(req.params.settlementId || "");
        const note = typeof req.body?.note === "string" ? req.body.note : undefined;
        const data = await accountingService.markPreviousCarrierSettlementPaid(
            actorFrom(req),
            settlementId,
            note,
            {
                paymentMethod: req.body?.paymentMethod,
                paymentDate: req.body?.paymentDate,
            }
        );
        return res.json(apiResponse(true, "Previous carrier settlement marked paid", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPreviousCarrierSettlementDetailsController(
    req: AuthRequest,
    res: Response
) {
    try {
        const settlementId = String(req.params.settlementId || "");
        const data = await accountingService.savePreviousCarrierSettlementDetails(
            actorFrom(req),
            settlementId,
            {
                paymentMethod: req.body?.paymentMethod,
                paymentDate: req.body?.paymentDate,
            }
        );
        return res.json(apiResponse(true, "Previous carrier settlement details saved", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPreviousCarrierSettlementInvoiceController(
    req: AuthRequest,
    res: Response
) {
    try {
        const settlementId = String(req.params.settlementId || "");
        const file = (req as AuthRequest & { file?: Express.Multer.File }).file;
        if (!file) {
            return res
                .status(400)
                .json(apiResponse(false, "Choose a file to upload", { code: "NO_FILE" }));
        }
        const data = await accountingService.uploadPreviousCarrierSettlementInvoice(
            actorFrom(req),
            settlementId,
            {
                originalName: file.originalname || "invoice.bin",
                mimeType: file.mimetype || "application/octet-stream",
                tempPath: file.path,
            }
        );
        return res.json(apiResponse(true, "Previous carrier invoice uploaded", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPayPalGenerateController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const { payPalCheckoutService } = await import("../paypal/paypal-checkout.service.js");
        const data = await payPalCheckoutService.generatePaymentLink(actorFrom(req), id);
        return res.json(apiResponse(true, "PayPal payment link ready", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPayPalStatusController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const { payPalCheckoutService } = await import("../paypal/paypal-checkout.service.js");
        const data = await payPalCheckoutService.refreshStatus(actorFrom(req), id);
        return res.json(apiResponse(true, "PayPal payment status", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingPayPalSendController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const { payPalCheckoutService } = await import("../paypal/paypal-checkout.service.js");
        const data = await payPalCheckoutService.sendPaymentLinkEmail(actorFrom(req), id);
        return res.json(
            apiResponse(
                true,
                data.emailTo
                    ? `PayPal payment link emailed to ${data.emailTo}`
                    : "PayPal payment link emailed",
                data
            )
        );
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

function paypalInvoiceController(
    action: "preview" | "createDraft" | "send" | "cancel" | "remind" | "sync",
    message: string
) {
    return async (req: AuthRequest, res: Response) => {
        try {
            const id = String(req.params.id || "");
            const { payPalInvoicingService } = await import("../paypal/paypal-invoicing.service.js");
            const actor = actorFrom(req);
            let data: unknown;
            if (action === "createDraft") {
                data = await payPalInvoicingService.createDraft(actor, id, {
                    confirmPricing: req.body?.confirmPricing === true,
                });
            } else if (action === "cancel") {
                const note = typeof req.body?.note === "string" ? req.body.note : undefined;
                data = await payPalInvoicingService.cancel(actor, id, note);
            } else {
                data = await payPalInvoicingService[action](actor, id);
            }
            return res.json(apiResponse(true, message, data));
        } catch (err) {
            return res.status(errStatus(err)).json(errPayload(err));
        }
    };
}

/** PayPal Invoicing API v2 — amounts are server-side only (never from body). */
export const accountingPayPalInvoicePreviewController = paypalInvoiceController(
    "preview",
    "PayPal invoice preview"
);
export const accountingPayPalInvoiceCreateController = paypalInvoiceController(
    "createDraft",
    "PayPal invoice draft ready"
);
export const accountingPayPalInvoiceSendController = paypalInvoiceController(
    "send",
    "PayPal invoice sent"
);
export const accountingPayPalInvoiceCancelController = paypalInvoiceController(
    "cancel",
    "PayPal invoice cancelled"
);
export const accountingPayPalInvoiceRemindController = paypalInvoiceController(
    "remind",
    "PayPal invoice reminder sent"
);
export const accountingPayPalInvoiceSyncController = paypalInvoiceController(
    "sync",
    "PayPal invoice status"
);

export async function paypalWebhookController(req: AuthRequest, res: Response) {
    try {
        const { payPalCheckoutService } = await import("../paypal/paypal-checkout.service.js");
        const requestWithRawBody = req as AuthRequest & { rawBody?: string };
        const rawBody =
            typeof requestWithRawBody.rawBody === "string"
                ? requestWithRawBody.rawBody
                : typeof req.body === "string"
                  ? req.body
                  : JSON.stringify(req.body || {});
        const data = await payPalCheckoutService.handleWebhook({
            headers: req.headers as Record<string, string | string[] | undefined>,
            rawBody,
        });
        // Fresh PROCESSING lease held by another worker → 503 so PayPal retries.
        // Completed / duplicate deliveries → 200 (do not re-execute).
        if (data?.retryable) {
            return res.status(503).json({ success: false, ...data });
        }
        return res.status(200).json({ success: true, ...data });
    } catch (err) {
        // Handler failures leave processResult=error: and must be retried by PayPal.
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

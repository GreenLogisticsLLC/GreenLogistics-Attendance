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
        const data = await accountingService.verifyDocuments(actorFrom(req), id, note);
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

export async function accountingCreateInvoiceController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.createInvoice(actorFrom(req), id, {
            invoiceNumber: req.body?.invoiceNumber,
            invoiceDate: req.body?.invoiceDate,
            dueDate: req.body?.dueDate,
        });
        return res.json(apiResponse(true, "Invoice created", data));
    } catch (err) {
        return res.status(errStatus(err)).json(errPayload(err));
    }
}

export async function accountingSendInvoiceController(req: AuthRequest, res: Response) {
    try {
        const id = String(req.params.id || "");
        const data = await accountingService.sendInvoice(actorFrom(req), id);
        return res.json(apiResponse(true, "Invoice marked sent", data));
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

import type { Response } from "express";
import fs from "fs";
import path from "path";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assertShipmentAccess } from "../../../auth/access.js";
import { canViewLoadProfit } from "../../../auth/roles.js";
import { loadService } from "../services/load.service.js";
import { loadDocumentsService } from "../services/load-documents.service.js";
import { LOAD_DOCS_ROOT } from "../services/load-pdf.service.js";
import { uploadPodFile } from "../services/pod-upload.service.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

function brokerInvoiceBlocked(role: string | undefined, docType: string): boolean {
    return (
        role === "Broker" &&
        ["CUSTOMER_INVOICE", "CARRIER_INVOICE"].includes(String(docType || "").toUpperCase())
    );
}

async function accessOr404(req: AuthRequest, res: Response, id: string) {
    return assertShipmentAccess(req, res, id);
}

const MONEY_PATCH_KEYS = [
    "carrierRate",
    "fuelSurcharge",
    "accessorialCharges",
    "factoringFee",
    "price",
] as const;

function stripMoneyFromPricing(pricing: Record<string, unknown> | null | undefined) {
    if (!pricing) return null;
    const customerRate =
        pricing.customerRate != null
            ? pricing.customerRate
            : pricing.fromCustomer != null
              ? pricing.fromCustomer
              : null;
    return {
        restricted: true,
        message: "Money / Profit is visible only to Accounting and Owner",
        // Brokers may see/edit operational Rate (customer side) without profit.
        customerRate,
        fromCustomer: customerRate,
        hasCustomerPrice: customerRate != null && customerRate !== "",
    };
}

function redactLoadListRow(row: Record<string, unknown>) {
    return { ...row, pricing: stripMoneyFromPricing(row.pricing as Record<string, unknown>) };
}

function redactLoadDetails(data: Record<string, unknown>) {
    const out: Record<string, unknown> = {
        ...data,
        pricing: stripMoneyFromPricing(data.pricing as Record<string, unknown>),
    };
    if (out.accounting && typeof out.accounting === "object") {
        const a = { ...(out.accounting as Record<string, unknown>) };
        delete a.brokerProfit;
        delete a.companyProfit;
        delete a.margin;
        delete a.outstandingBalance;
        a.restricted = true;
        out.accounting = a;
    }
    out.canViewMoney = false;
    return out;
}

export const loadController = {
    async list(req: AuthRequest, res: Response) {
        try {
            const phase = String(req.query.phase || "active") as "active" | "completed" | "all";
            const role = req.user?.role || "";
            const data = await loadService.listLoads({
                phase,
                brokerId: role === "Broker" ? req.user?.userId : undefined,
            });
            const safe = canViewLoadProfit(role)
                ? data
                : (data as Record<string, unknown>[]).map(redactLoadListRow);
            res.json({ success: true, data: safe });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to list loads",
            });
        }
    },

    async get(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const includeGps =
                String(req.query.includeGps || req.query.gps || "") === "1" ||
                String(req.query.includeGps || "").toLowerCase() === "true";
            const data = await loadService.getLoadDetails(id, { includeGps });
            const role = req.user?.role || "";
            const payload = canViewLoadProfit(role)
                ? { ...data, canViewMoney: true }
                : redactLoadDetails(data as unknown as Record<string, unknown>);
            res.json({ success: true, data: payload });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to load details",
            });
        }
    },

    async create(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            // Ignore any client-supplied load number — system only.
            await loadService.createLoad(id, req.user?.userId);
            const data = await loadService.getLoadDetails(id);
            const role = req.user?.role || "";
            const payload = canViewLoadProfit(role)
                ? { ...data, canViewMoney: true }
                : redactLoadDetails(data as unknown as Record<string, unknown>);
            res.json({ success: true, message: "Load Number assigned automatically", data: payload });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to create load",
            });
        }
    },

    async update(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const body = { ...(req.body || {}) } as Record<string, unknown>;
            const role = req.user?.role || "";
            if (!canViewLoadProfit(role)) {
                const blocked = MONEY_PATCH_KEYS.filter((k) => body[k] !== undefined);
                if (blocked.length) {
                    return res.status(403).json({
                        success: false,
                        message:
                            "Only Accounting and Owner can set Carrier price and Profit fields",
                    });
                }
            }
            const data = await loadService.updateLoad(id, body, req.user?.userId);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to update load",
            });
        }
    },

    async action(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const action = String(req.params.action || req.body?.action || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const data = await loadService.runAction(
                id,
                action,
                req.user?.userId,
                req.body || {},
                req.user?.role
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to run action",
            });
        }
    },

    async listDocuments(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const data = await loadDocumentsService.listCurrent(id);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to list documents",
            });
        }
    },

    async documentHistory(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const docType = String(req.params.docType || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const data = await loadDocumentsService.history(id, docType);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to load history",
            });
        }
    },

    async generateDocument(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const docType = String(req.params.docType || req.body?.docType || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            if (brokerInvoiceBlocked(req.user?.role, docType)) {
                return res.status(403).json({
                    success: false,
                    message: "Invoice and payment work is handled by Accounting after POD",
                });
            }
            const row = await loadDocumentsService.generate({
                shipmentLeadId: id,
                docType,
                actorUserId: req.user?.userId,
                actorRole: req.user?.role,
                acknowledgeComplianceReview:
                    req.body?.acknowledgeComplianceReview === true,
                contentOverrides: req.body?.content,
                changeReason: req.body?.changeReason || "GENERATED",
            });
            res.json({ success: true, data: row });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to generate document",
            });
        }
    },

    async editDocument(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const docType = String(req.params.docType || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            if (brokerInvoiceBlocked(req.user?.role, docType)) {
                return res.status(403).json({
                    success: false,
                    message: "Invoice and payment work is handled by Accounting after POD",
                });
            }
            const row = await loadDocumentsService.edit({
                shipmentLeadId: id,
                docType,
                content: req.body?.content || req.body || {},
                changeReason: req.body?.changeReason || "BROKER_EDITED",
                actorUserId: req.user?.userId,
                actorRole: req.user?.role,
                acknowledgeComplianceReview:
                    req.body?.acknowledgeComplianceReview === true,
            });
            res.json({ success: true, data: row });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to edit document",
            });
        }
    },

    async uploadPod(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const file = req.file;
            if (!file?.path) {
                res.status(400).json({ success: false, message: "POD file is required" });
                return;
            }
            const confirmSignature =
                String(req.body?.confirmSignature || "") === "1" ||
                String(req.body?.confirmSignature || "").toLowerCase() === "true";
            const manualApprove =
                String(req.body?.manualApprove || "") === "1" ||
                String(req.body?.manualApprove || "").toLowerCase() === "true";
            try {
                const data = await uploadPodFile({
                    shipmentLeadId: id,
                    actorUserId: req.user?.userId,
                    actorRole: req.user?.role,
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    tempPath: file.path,
                    confirmSignature,
                    manualApprove,
                    manualApprovalReason: String(req.body?.manualApprovalReason || ""),
                });
                res.json({ success: true, data });
            } catch (err) {
                if (file.path && fs.existsSync(file.path)) {
                    try {
                        fs.unlinkSync(file.path);
                    } catch {
                        /* ignore */
                    }
                }
                throw err;
            }
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                code: (err as { code?: string }).code,
                analysis: (err as { analysis?: unknown }).analysis,
                message: err instanceof Error ? err.message : "POD upload failed",
            });
        }
    },

    async uploadPaymentProof(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const docType = String(req.params.docType || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            if (!canViewLoadProfit(req.user?.role || "")) {
                return res.status(403).json({
                    success: false,
                    message: "Only Accounting and Owner can upload payment documents",
                });
            }
            const file = req.file;
            if (!file?.path) {
                res.status(400).json({ success: false, message: "Payment document is required" });
                return;
            }
            try {
                const data = await loadDocumentsService.uploadProof({
                    shipmentLeadId: id,
                    docType,
                    actorUserId: req.user?.userId,
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    tempPath: file.path,
                });
                res.json({ success: true, data });
            } catch (err) {
                if (file.path && fs.existsSync(file.path)) {
                    try {
                        fs.unlinkSync(file.path);
                    } catch {
                        /* ignore */
                    }
                }
                throw err;
            }
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Payment document upload failed",
            });
        }
    },

    async downloadDocument(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const documentId = String(req.params.documentId || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const row = await loadDocumentsService.getById(documentId);
            if (row.shipmentLeadId !== id) {
                res.status(404).json({ success: false, message: "Document not found on this Load" });
                return;
            }
            if (!row.storedName) {
                res.status(404).json({ success: false, message: "PDF file missing" });
                return;
            }
            const abs = path.join(LOAD_DOCS_ROOT, id, row.storedName);
            if (!fs.existsSync(abs)) {
                res.status(404).json({ success: false, message: "PDF file missing on disk" });
                return;
            }
            res.setHeader("Content-Type", row.mimeType || "application/pdf");
            res.setHeader(
                "Content-Disposition",
                `${req.query.inline === "1" ? "inline" : "attachment"}; filename="${row.fileName || "document.pdf"}"`
            );
            fs.createReadStream(abs).pipe(res);
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to download",
            });
        }
    },

    async archiveDocument(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const documentId = String(req.params.documentId || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const row = await loadDocumentsService.getById(documentId);
            if (row.shipmentLeadId !== id) {
                res.status(404).json({ success: false, message: "Document not found on this Load" });
                return;
            }
            const data = await loadDocumentsService.archive(documentId, req.user?.userId);
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to archive",
            });
        }
    },

    async markDocumentSent(req: AuthRequest, res: Response) {
        try {
            const id = String(req.params.id || "");
            const documentId = String(req.params.documentId || "");
            const access = await accessOr404(req, res, id);
            if (!access.ok) return;
            const row = await loadDocumentsService.getById(documentId);
            if (row.shipmentLeadId !== id) {
                res.status(404).json({ success: false, message: "Document not found on this Load" });
                return;
            }
            const data = await loadDocumentsService.markSent(documentId, req.user?.userId);
            res.json({
                success: true,
                message: "Marked as sent. Wire email provider to auto-attach PDF.",
                data,
            });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to mark sent",
            });
        }
    },
};

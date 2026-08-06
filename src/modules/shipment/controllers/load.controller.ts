import type { Response } from "express";
import fs from "fs";
import path from "path";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { assertShipmentAccess } from "../../../auth/access.js";
import { loadService } from "../services/load.service.js";
import { loadDocumentsService } from "../services/load-documents.service.js";
import { LOAD_DOCS_ROOT } from "../services/load-pdf.service.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

async function accessOr404(req: AuthRequest, res: Response, id: string) {
    return assertShipmentAccess(req, res, id);
}

export const loadController = {
    async list(req: AuthRequest, res: Response) {
        try {
            const phase = String(req.query.phase || "active") as "active" | "completed" | "all";
            const data = await loadService.listLoads({ phase });
            res.json({ success: true, data });
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
            const data = await loadService.getLoadDetails(id);
            res.json({ success: true, data });
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
            res.json({ success: true, message: "Load Number assigned automatically", data });
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
            const data = await loadService.updateLoad(id, req.body || {}, req.user?.userId);
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
            const data = await loadService.runAction(id, action, req.user?.userId, req.body || {});
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
            const row = await loadDocumentsService.generate({
                shipmentLeadId: id,
                docType,
                actorUserId: req.user?.userId,
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
            const row = await loadDocumentsService.edit({
                shipmentLeadId: id,
                docType,
                content: req.body?.content || req.body || {},
                changeReason: req.body?.changeReason || "BROKER_EDITED",
                actorUserId: req.user?.userId,
            });
            res.json({ success: true, data: row });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to edit document",
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

import type { Response } from "express";
import fs from "fs";
import multer from "multer";
import os from "os";
import path from "path";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { carrierService } from "../services/carrier.service.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

function actorFrom(req: AuthRequest) {
    return {
        userId: req.user?.userId,
        role: req.user?.role,
        ip: req.ip,
        userAgent: req.get("user-agent") || undefined,
    };
}

function publicMeta(req: { ip?: string; get: (h: string) => string | undefined }) {
    return { ip: req.ip, userAgent: req.get("user-agent") || undefined };
}

export const carrierUpload = multer({
    dest: (() => {
        const dir = path.join(os.tmpdir(), "greenos-carrier-uploads");
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    })(),
    limits: { fileSize: 15 * 1024 * 1024 },
});

export const carriersController = {
    async list(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.list(actorFrom(req), {
                status: req.query.status ? String(req.query.status) : undefined,
                q: req.query.q ? String(req.query.q) : undefined,
            });
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to list carriers",
            });
        }
    },

    async dashboard(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.dashboard(actorFrom(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async get(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.get(String(req.params.id), actorFrom(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async create(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.createAndInvite(req.body || {}, actorFrom(req));
            res.status(201).json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to create carrier",
            });
        }
    },

    async patch(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.patch(String(req.params.id), req.body || {}, actorFrom(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async invite(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.resendInvite(String(req.params.id), actorFrom(req));
            res.json({ success: true, data: { sent: data.sent, warning: data.warning } });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async resend(req: AuthRequest, res: Response) {
        return carriersController.invite(req, res);
    },

    async requestChanges(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.requestChanges(
                String(req.params.id),
                String(req.body?.reason || ""),
                actorFrom(req)
            );
            res.json({ success: true, data: { sent: data.sent, warning: data.warning } });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async inviteAgreementFromLoad(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.inviteAgreementFromLoad(
                String(req.params.shipmentLeadId),
                actorFrom(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                code: (err as { code?: string }).code,
                message: err instanceof Error ? err.message : "Failed to send agreement link",
            });
        }
    },

    async inviteRcBolFromLoad(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.inviteRcBolFromLoad(
                String(req.params.shipmentLeadId),
                actorFrom(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                code: (err as { code?: string }).code,
                message: err instanceof Error ? err.message : "Failed to send RC/BOL link",
            });
        }
    },

    async approve(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.approve(String(req.params.id), actorFrom(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async reject(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.reject(
                String(req.params.id),
                String(req.body?.reason || ""),
                actorFrom(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async regenerateAgreementPdf(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.regenerateAgreementPdf(
                String(req.params.id),
                actorFrom(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to generate PDF",
            });
        }
    },

    async downloadDocument(req: AuthRequest, res: Response) {
        try {
            const { doc, absolutePath } = await carrierService.downloadDocument(
                String(req.params.id),
                String(req.params.documentId),
                actorFrom(req)
            );
            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ success: false, message: "File missing on disk" });
            }
            res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`
            );
            fs.createReadStream(absolutePath).pipe(res);
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },
};

export const carrierOnboardingPublicController = {
    async get(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.publicGet(String(req.params.token), publicMeta(req));
            res.setHeader("X-Robots-Tag", "noindex, nofollow");
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                code: (err as { code?: string }).code,
                message: err instanceof Error ? err.message : "Invalid onboarding link.",
            });
        }
    },

    async save(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.publicSave(
                String(req.params.token),
                req.body || {},
                publicMeta(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                code: (err as { code?: string }).code,
                message: err instanceof Error ? err.message : "Failed to save",
            });
        }
    },

    async signAgreement(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.publicSignAgreement(
                String(req.params.token),
                req.body || {},
                publicMeta(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async signRc(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.publicSignRc(
                String(req.params.token),
                req.body || {},
                publicMeta(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async upload(req: AuthRequest, res: Response) {
        try {
            const file = req.file;
            if (!file) {
                return res.status(400).json({ success: false, message: "File is required" });
            }
            const data = await carrierService.publicUpload(
                String(req.params.token),
                {
                    documentType: String(req.body?.documentType || ""),
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    tempPath: file.path,
                },
                publicMeta(req)
            );
            res.json({ success: true, data });
        } catch (err) {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                try {
                    fs.unlinkSync(req.file.path);
                } catch {
                    /* ignore */
                }
            }
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Upload failed",
            });
        }
    },

    async submit(req: AuthRequest, res: Response) {
        try {
            const data = await carrierService.publicSubmit(String(req.params.token), publicMeta(req));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                missing: (err as { missing?: string[] }).missing,
                message: err instanceof Error ? err.message : "Submit failed",
            });
        }
    },

    async downloadLoadDocument(req: AuthRequest, res: Response) {
        try {
            const file = await carrierService.publicDownloadLoadDocument(
                String(req.params.token),
                String(req.params.documentId),
                req.ip
            );
            res.setHeader("Content-Type", file.mimeType);
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${file.fileName.replace(/"/g, "")}"`
            );
            res.setHeader("X-Robots-Tag", "noindex, nofollow");
            fs.createReadStream(file.absolutePath).pipe(res);
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Download failed",
            });
        }
    },
};

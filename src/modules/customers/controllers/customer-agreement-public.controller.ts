import type { Request, Response } from "express";
import { customerAgreementInviteService } from "../services/customer-agreement-invite.service.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

export const customerAgreementPublicController = {
    async get(req: Request, res: Response) {
        try {
            const data = await customerAgreementInviteService.getByToken(String(req.params.token || ""));
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },

    async save(req: Request, res: Response) {
        try {
            const data = await customerAgreementInviteService.saveFields(
                String(req.params.token || ""),
                (req.body && req.body.fields) || req.body || {}
            );
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to save",
            });
        }
    },

    async sign(req: Request, res: Response) {
        try {
            const data = await customerAgreementInviteService.sign(String(req.params.token || ""), req.body || {});
            res.json({ success: true, data });
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed to sign",
            });
        }
    },

    async downloadSigned(req: Request, res: Response) {
        try {
            const file = await customerAgreementInviteService.readSignedPdf(
                String(req.params.token || "")
            );
            if (!file) {
                res.status(404).json({ success: false, message: "Signed PDF not ready yet" });
                return;
            }
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${file.filename.replace(/"/g, "")}"`
            );
            res.send(file.content);
        } catch (err) {
            res.status(errStatus(err)).json({
                success: false,
                message: err instanceof Error ? err.message : "Failed",
            });
        }
    },
};

import type { Response } from "express";
import { apiResponse } from "../../../utils/helpers.js";
import type { AuthRequest } from "../../../middlewares/auth.middleware.js";
import { aiThreadsService } from "../services/ai-threads.service.js";

function errStatus(err: unknown): number {
    return (err as { status?: number })?.status || 500;
}

export async function listAiThreadsController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.list(req.user!.userId);
        return res.json(apiResponse(true, "GREEN chats", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function getAiThreadController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.get(req.user!.userId, String(req.params.id || ""));
        return res.json(apiResponse(true, "GREEN chat", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function createAiThreadController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.create(req.user!.userId, {
            title: req.body?.title,
            messages: req.body?.messages,
            pinned: req.body?.pinned,
            folderId:
                req.body?.folderId === undefined
                    ? undefined
                    : req.body?.folderId === null || req.body?.folderId === ""
                      ? null
                      : String(req.body.folderId),
        });
        return res.status(201).json(apiResponse(true, "Chat created", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function updateAiThreadController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.update(
            req.user!.userId,
            String(req.params.id || ""),
            {
                title: req.body?.title,
                pinned: req.body?.pinned,
                messages: req.body?.messages,
                folderId:
                    req.body?.folderId === undefined
                        ? undefined
                        : req.body?.folderId === null || req.body?.folderId === ""
                          ? null
                          : String(req.body.folderId),
            }
        );
        return res.json(apiResponse(true, "Chat updated", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function listAiFoldersController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.listFolders(req.user!.userId);
        return res.json(apiResponse(true, "GREEN folders", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function createAiFolderController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.createFolder(
            req.user!.userId,
            String(req.body?.name || "")
        );
        return res.status(201).json(apiResponse(true, "Folder created", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function updateAiFolderController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.updateFolder(
            req.user!.userId,
            String(req.params.id || ""),
            String(req.body?.name || "")
        );
        return res.json(apiResponse(true, "Folder updated", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function deleteAiFolderController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.removeFolder(
            req.user!.userId,
            String(req.params.id || "")
        );
        return res.json(apiResponse(true, "Folder deleted", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

export async function deleteAiThreadController(req: AuthRequest, res: Response) {
    try {
        const data = await aiThreadsService.remove(
            req.user!.userId,
            String(req.params.id || "")
        );
        return res.json(apiResponse(true, "Chat deleted", data));
    } catch (err) {
        return res
            .status(errStatus(err))
            .json(apiResponse(false, err instanceof Error ? err.message : "Failed"));
    }
}

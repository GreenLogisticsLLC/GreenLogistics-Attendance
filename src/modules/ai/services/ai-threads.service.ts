import { prisma } from "../../../config/database.js";

export type ThreadMessage = {
    role: "user" | "assistant";
    content: string;
    at?: string;
};

function parseMessages(raw: string | null | undefined): ThreadMessage[] {
    try {
        const arr = JSON.parse(raw || "[]");
        if (!Array.isArray(arr)) return [];
        return arr
            .filter(
                (m) =>
                    m &&
                    (m.role === "user" || m.role === "assistant") &&
                    typeof m.content === "string"
            )
            .map((m) => ({
                role: m.role as "user" | "assistant",
                content: String(m.content).slice(0, 20000),
                at: m.at ? String(m.at) : undefined,
            }));
    } catch {
        return [];
    }
}

function titleFromMessages(messages: ThreadMessage[], fallback = "New chat"): string {
    const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
    if (!firstUser) return fallback;
    const t = firstUser.content.trim().replace(/\s+/g, " ");
    return t.length > 56 ? t.slice(0, 53) + "…" : t;
}

function serialize(row: {
    threadId: string;
    title: string;
    pinned: boolean;
    folderId?: string | null;
    messagesJson: string;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        threadId: row.threadId,
        title: row.title,
        pinned: row.pinned,
        folderId: row.folderId || null,
        messages: parseMessages(row.messagesJson),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export class AiThreadsService {
    async listFolders(userId: string) {
        const rows = await prisma.aiAgentFolder.findMany({
            where: { userId },
            orderBy: [{ name: "asc" }],
            take: 50,
            select: {
                folderId: true,
                name: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { threads: true } },
            },
        });
        return rows.map((row) => ({
            folderId: row.folderId,
            name: row.name,
            threadCount: row._count.threads,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        }));
    }

    async createFolder(userId: string, name: string) {
        const n = String(name || "").trim();
        if (!n) throw Object.assign(new Error("Folder name is required"), { status: 422 });
        const row = await prisma.aiAgentFolder.create({
            data: { userId, name: n.slice(0, 80) },
        });
        return {
            folderId: row.folderId,
            name: row.name,
            threadCount: 0,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    }

    async updateFolder(userId: string, folderId: string, name: string) {
        const existing = await prisma.aiAgentFolder.findFirst({
            where: { folderId, userId },
        });
        if (!existing) throw Object.assign(new Error("Folder not found"), { status: 404 });
        const n = String(name || "").trim();
        if (!n) throw Object.assign(new Error("Folder name is required"), { status: 422 });
        const row = await prisma.aiAgentFolder.update({
            where: { folderId },
            data: { name: n.slice(0, 80) },
        });
        return {
            folderId: row.folderId,
            name: row.name,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    }

    async removeFolder(userId: string, folderId: string) {
        const existing = await prisma.aiAgentFolder.findFirst({
            where: { folderId, userId },
            select: { folderId: true },
        });
        if (!existing) throw Object.assign(new Error("Folder not found"), { status: 404 });
        await prisma.aiAgentThread.updateMany({
            where: { userId, folderId },
            data: { folderId: null },
        });
        await prisma.aiAgentFolder.delete({ where: { folderId } });
        return { deleted: true, folderId };
    }

    async assertFolderOwned(userId: string, folderId: string | null | undefined) {
        if (folderId == null || folderId === "") return null;
        const folder = await prisma.aiAgentFolder.findFirst({
            where: { folderId: String(folderId), userId },
            select: { folderId: true },
        });
        if (!folder) throw Object.assign(new Error("Folder not found"), { status: 404 });
        return folder.folderId;
    }

    async list(userId: string) {
        const rows = await prisma.aiAgentThread.findMany({
            where: { userId },
            orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
            take: 100,
            select: {
                threadId: true,
                title: true,
                pinned: true,
                folderId: true,
                messagesJson: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        return rows.map((row) => {
            const messages = parseMessages(row.messagesJson);
            return {
                threadId: row.threadId,
                title: row.title,
                pinned: row.pinned,
                folderId: row.folderId || null,
                messageCount: messages.length,
                preview: messages.length
                    ? messages[messages.length - 1].content.slice(0, 80)
                    : "",
                createdAt: row.createdAt.toISOString(),
                updatedAt: row.updatedAt.toISOString(),
            };
        });
    }

    async get(userId: string, threadId: string) {
        const row = await prisma.aiAgentThread.findFirst({
            where: { threadId, userId },
        });
        if (!row) {
            throw Object.assign(new Error("Chat not found"), { status: 404 });
        }
        return serialize(row);
    }

    async create(
        userId: string,
        input?: {
            title?: string;
            messages?: ThreadMessage[];
            pinned?: boolean;
            folderId?: string | null;
        }
    ) {
        const messages = Array.isArray(input?.messages) ? input!.messages! : [];
        const title =
            String(input?.title || "").trim() || titleFromMessages(messages, "New chat");
        const folderId = await this.assertFolderOwned(userId, input?.folderId);
        const row = await prisma.aiAgentThread.create({
            data: {
                userId,
                title: title.slice(0, 120),
                pinned: Boolean(input?.pinned),
                folderId,
                messagesJson: JSON.stringify(messages.slice(-80)),
            },
        });
        return serialize(row);
    }

    async update(
        userId: string,
        threadId: string,
        input: {
            title?: string;
            pinned?: boolean;
            messages?: ThreadMessage[];
            folderId?: string | null;
        }
    ) {
        const existing = await prisma.aiAgentThread.findFirst({
            where: { threadId, userId },
        });
        if (!existing) {
            throw Object.assign(new Error("Chat not found"), { status: 404 });
        }
        const data: {
            title?: string;
            pinned?: boolean;
            messagesJson?: string;
            folderId?: string | null;
        } = {};
        if (input.title != null) {
            const t = String(input.title).trim();
            if (!t) throw Object.assign(new Error("Title is required"), { status: 422 });
            data.title = t.slice(0, 120);
        }
        if (input.pinned != null) data.pinned = Boolean(input.pinned);
        if (input.folderId !== undefined) {
            data.folderId = await this.assertFolderOwned(userId, input.folderId);
        }
        if (Array.isArray(input.messages)) {
            const messages = input.messages.slice(-80);
            data.messagesJson = JSON.stringify(messages);
            if (!data.title && existing.title === "New chat") {
                data.title = titleFromMessages(messages, existing.title);
            }
        }
        const row = await prisma.aiAgentThread.update({
            where: { threadId },
            data,
        });
        return serialize(row);
    }

    async remove(userId: string, threadId: string) {
        const existing = await prisma.aiAgentThread.findFirst({
            where: { threadId, userId },
            select: { threadId: true },
        });
        if (!existing) {
            throw Object.assign(new Error("Chat not found"), { status: 404 });
        }
        await prisma.aiAgentThread.delete({ where: { threadId } });
        return { deleted: true, threadId };
    }
}

export const aiThreadsService = new AiThreadsService();

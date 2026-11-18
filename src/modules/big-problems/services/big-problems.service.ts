import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { prisma } from "../../../config/database.js";
import { Roles } from "../../../auth/roles.js";
import { platformNotificationService } from "../../shipment/services/platform-notification.service.js";
import {
    BP_CATEGORIES,
    BP_CASE_STATUSES,
    BP_COMM_CHANNELS,
    BP_DOC_KINDS,
    BP_OPEN_STATUSES,
    BP_SEVERITIES,
    BP_TASK_PRIORITIES,
    BP_TASK_STATUSES,
    CATEGORY_LABELS,
} from "../constants.js";
import { computeBigProblemFinancials } from "../financials.js";
import {
    brokerCaseVisibilityFilter,
    canAssignBigProblemTasks,
    canCloseBigProblemCase,
    canCreateBigProblemCase,
    canEditBigProblemCase,
    canEditBigProblemFinancials,
    canViewBigProblemCase,
    canViewBigProblemFinancials,
    isBpBroker,
    isBpOpsLead,
    type BpActor,
} from "../permissions.js";
import { allocateBigProblemCaseNumber } from "./case-id.service.js";
import { listBpTimeline, recordBpTimeline } from "./timeline.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BP_UPLOADS_ROOT = path.join(__dirname, "..", "..", "..", "..", "uploads", "big-problems");

function moneyErr(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

function actorNameFromUser(u: {
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
}): string {
    const n = `${u.firstName || ""} ${u.lastName || ""}`.trim();
    return n || u.username || "User";
}

async function loadActorProfile(actor: BpActor) {
    const user = await prisma.user.findUnique({
        where: { userId: actor.userId },
        select: { userId: true, firstName: true, lastName: true, username: true },
    });
    return {
        ...actor,
        name: user ? actorNameFromUser(user) : actor.userId,
    };
}

const caseInclude = {
    financials: true,
    customer: { select: { customerId: true, companyName: true } },
    responsibleManager: {
        select: { userId: true, firstName: true, lastName: true, username: true },
    },
    brokerUser: {
        select: { userId: true, firstName: true, lastName: true, username: true },
    },
    shipmentLead: {
        select: {
            shipmentLeadId: true,
            greenOsShipmentId: true,
            loadNumber: true,
            shipmentTitle: true,
        },
    },
    tasks: {
        select: {
            taskId: true,
            title: true,
            status: true,
            priority: true,
            deadlineAt: true,
            assigneeUserId: true,
        },
    },
} as const;

function serializeCase(row: any, actor: BpActor) {
    const showFin = canViewBigProblemFinancials(actor.role);
    const nextOpenTask = (row.tasks || [])
        .filter((t: any) => t.status === "OPEN" || t.status === "IN_PROGRESS")
        .sort((a: any, b: any) => {
            const da = a.deadlineAt ? new Date(a.deadlineAt).getTime() : Number.MAX_SAFE_INTEGER;
            const db = b.deadlineAt ? new Date(b.deadlineAt).getTime() : Number.MAX_SAFE_INTEGER;
            return da - db;
        })[0];

    const base: Record<string, unknown> = {
        caseId: row.caseId,
        caseNumber: row.caseNumber,
        title: row.title,
        description: row.description,
        category: row.category,
        categoryLabel: CATEGORY_LABELS[row.category] || row.category,
        severity: row.severity,
        status: row.status,
        incidentDate: row.incidentDate,
        responsibleManagerId: row.responsibleManagerId,
        responsibleManagerName: row.responsibleManager
            ? actorNameFromUser(row.responsibleManager)
            : null,
        brokerUserId: row.brokerUserId,
        brokerName: row.brokerUser ? actorNameFromUser(row.brokerUser) : null,
        customerId: row.customerId,
        customerName: row.customer?.companyName || null,
        carrierId: row.carrierId,
        carrierName: row.carrierName,
        shipmentLeadId: row.shipmentLeadId,
        shipmentId:
            row.shipmentLead?.greenOsShipmentId ||
            row.shipmentLead?.loadNumber ||
            row.shipmentRef ||
            null,
        shipmentTitle: row.shipmentLead?.shipmentTitle || null,
        nextDeadlineAt: row.nextDeadlineAt || nextOpenTask?.deadlineAt || null,
        closedAt: row.closedAt,
        resolutionSummary: row.resolutionSummary,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        openTaskCount: (row.tasks || []).filter(
            (t: any) => t.status === "OPEN" || t.status === "IN_PROGRESS"
        ).length,
        overdueTaskCount: (row.tasks || []).filter((t: any) => {
            if (t.status === "COMPLETED" || t.status === "CANCELLED") return false;
            return t.deadlineAt && new Date(t.deadlineAt).getTime() < Date.now();
        }).length,
    };

    if (showFin && row.financials) {
        base.financials = row.financials;
        base.financialExposure = row.financials.outstandingExposure;
        base.potentialExposure = row.financials.potentialExposure;
        base.outstandingExposure = row.financials.outstandingExposure;
    } else if (showFin) {
        base.financials = null;
        base.financialExposure = 0;
        base.potentialExposure = 0;
        base.outstandingExposure = 0;
    }

    return base;
}

async function assertCaseAccess(actor: BpActor, caseId: string) {
    const row = await prisma.bigProblemCase.findUnique({
        where: { caseId },
        include: {
            tasks: { select: { assigneeUserId: true } },
        },
    });
    if (!row) throw moneyErr(404, "Case not found");
    const ok = canViewBigProblemCase(actor, {
        responsibleManagerId: row.responsibleManagerId,
        brokerUserId: row.brokerUserId,
        createdByUserId: row.createdByUserId,
        taskAssigneeIds: row.tasks.map((t) => t.assigneeUserId).filter(Boolean) as string[],
    });
    if (!ok) throw moneyErr(403, "Access denied to this case");
    return row;
}

async function refreshNextDeadline(caseId: string) {
    const next = await prisma.bigProblemTask.findFirst({
        where: {
            caseId,
            status: { in: ["OPEN", "IN_PROGRESS"] },
            deadlineAt: { not: null },
        },
        orderBy: { deadlineAt: "asc" },
        select: { deadlineAt: true },
    });
    await prisma.bigProblemCase.update({
        where: { caseId },
        data: { nextDeadlineAt: next?.deadlineAt || null },
    });
}

async function notifyUsers(input: {
    userIds: string[];
    title: string;
    message: string;
    meta?: Record<string, unknown>;
    shipmentLeadId?: string | null;
}) {
    const unique = [...new Set(input.userIds.filter(Boolean))];
    for (const userId of unique) {
        await platformNotificationService.notifyUser({
            userId,
            notificationType: "BIG_PROBLEM",
            title: input.title,
            message: input.message,
            shipmentLeadId: input.shipmentLeadId || undefined,
            meta: input.meta,
        });
    }
}

export class BigProblemsService {
    meta() {
        return {
            categories: BP_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] || id })),
            severities: [...BP_SEVERITIES],
            caseStatuses: [...BP_CASE_STATUSES],
            taskPriorities: [...BP_TASK_PRIORITIES],
            taskStatuses: [...BP_TASK_STATUSES],
            docKinds: [...BP_DOC_KINDS],
            communicationChannels: [...BP_COMM_CHANNELS],
        };
    }

    async listAssignableUsers() {
        const users = await prisma.user.findMany({
            where: {
                isActive: true,
                role: {
                    roleName: {
                        in: [
                            Roles.Owner,
                            Roles.Administrator,
                            Roles.Manager,
                            Roles.TeamLead,
                            Roles.Broker,
                            Roles.Accounting,
                        ],
                    },
                },
            },
            select: {
                userId: true,
                firstName: true,
                lastName: true,
                username: true,
                role: { select: { roleName: true } },
            },
            orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        });
        return users.map((u) => ({
            userId: u.userId,
            name: actorNameFromUser(u),
            role: u.role.roleName,
        }));
    }

    async overview(actor: BpActor) {
        const where = isBpBroker(actor.role) ? brokerCaseVisibilityFilter(actor.userId) : {};
        const cases = await prisma.bigProblemCase.findMany({
            where,
            include: {
                financials: true,
                tasks: {
                    select: {
                        taskId: true,
                        status: true,
                        deadlineAt: true,
                        assigneeUserId: true,
                    },
                },
            },
        });

        const now = Date.now();
        let openCases = 0;
        let criticalCases = 0;
        let outstandingTasks = 0;
        let overdueTasks = 0;
        let totalExposure = 0;
        const attention: any[] = [];

        for (const c of cases) {
            const isOpen = BP_OPEN_STATUSES.includes(c.status as any) && c.status !== "CLOSED";
            if (c.status !== "CLOSED") openCases += 1;
            if (c.severity === "CRITICAL" && c.status !== "CLOSED") criticalCases += 1;
            if (canViewBigProblemFinancials(actor.role) && c.financials) {
                totalExposure += Number(c.financials.outstandingExposure || 0);
            }
            for (const t of c.tasks) {
                if (t.status === "OPEN" || t.status === "IN_PROGRESS") {
                    outstandingTasks += 1;
                    if (t.deadlineAt && new Date(t.deadlineAt).getTime() < now) overdueTasks += 1;
                }
            }
            const hasOverdue = c.tasks.some(
                (t) =>
                    (t.status === "OPEN" || t.status === "IN_PROGRESS") &&
                    t.deadlineAt &&
                    new Date(t.deadlineAt).getTime() < now
            );
            if (
                c.status !== "CLOSED" &&
                (c.severity === "CRITICAL" || hasOverdue || c.status === "PENDING_REVIEW")
            ) {
                attention.push({
                    caseId: c.caseId,
                    caseNumber: c.caseNumber,
                    title: c.title,
                    severity: c.severity,
                    status: c.status,
                    reason: hasOverdue
                        ? "Overdue task"
                        : c.severity === "CRITICAL"
                          ? "Critical"
                          : "Needs review",
                });
            }
        }

        return {
            totalCases: cases.length,
            openCases,
            criticalCases,
            outstandingTasks,
            overdueTasks,
            totalFinancialExposure: canViewBigProblemFinancials(actor.role)
                ? Math.round(totalExposure * 100) / 100
                : null,
            casesRequiringAttention: attention.slice(0, 25),
            canViewFinancials: canViewBigProblemFinancials(actor.role),
            canCreate: canCreateBigProblemCase(actor.role),
        };
    }

    async listCases(
        actor: BpActor,
        query: {
            q?: string;
            status?: string;
            severity?: string;
            category?: string;
            closed?: string;
            page?: number;
            pageSize?: number;
            sort?: string;
            sortDir?: string;
        }
    ) {
        const page = Math.max(1, Number(query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
        const where: any = isBpBroker(actor.role)
            ? brokerCaseVisibilityFilter(actor.userId)
            : {};

        if (query.closed === "1" || query.status === "CLOSED") {
            where.status = "CLOSED";
        } else if (query.status) {
            where.status = query.status;
        } else if (query.closed === "0") {
            where.status = { not: "CLOSED" };
        }

        if (query.severity) where.severity = query.severity;
        if (query.category) where.category = query.category;

        if (query.q && query.q.trim()) {
            const q = query.q.trim();
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { caseNumber: { contains: q } },
                        { title: { contains: q } },
                        { description: { contains: q } },
                        { carrierName: { contains: q } },
                        { shipmentRef: { contains: q } },
                        { customer: { companyName: { contains: q } } },
                    ],
                },
            ];
        }

        const sortField = query.sort || "updatedAt";
        const sortDir = query.sortDir === "asc" ? "asc" : "desc";
        const orderBy: any =
            sortField === "severity"
                ? { severity: sortDir }
                : sortField === "status"
                  ? { status: sortDir }
                  : sortField === "caseNumber"
                    ? { caseNumber: sortDir }
                    : sortField === "nextDeadlineAt"
                      ? { nextDeadlineAt: sortDir }
                      : sortField === "createdAt"
                        ? { createdAt: sortDir }
                        : { updatedAt: sortDir };

        const [total, rows] = await Promise.all([
            prisma.bigProblemCase.count({ where }),
            prisma.bigProblemCase.findMany({
                where,
                include: caseInclude,
                orderBy,
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);

        return {
            items: rows.map((r) => serializeCase(r, actor)),
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            canViewFinancials: canViewBigProblemFinancials(actor.role),
            canCreate: canCreateBigProblemCase(actor.role),
        };
    }

    async getCase(actor: BpActor, caseId: string) {
        await assertCaseAccess(actor, caseId);
        const row = await prisma.bigProblemCase.findUnique({
            where: { caseId },
            include: {
                ...caseInclude,
                documents: { orderBy: { createdAt: "desc" } },
                communications: {
                    orderBy: { createdAt: "desc" },
                    take: 50,
                    include: {
                        author: {
                            select: { userId: true, firstName: true, lastName: true, username: true },
                        },
                    },
                },
                tasks: {
                    orderBy: [{ deadlineAt: "asc" }, { createdAt: "desc" }],
                    include: {
                        assignee: {
                            select: {
                                userId: true,
                                firstName: true,
                                lastName: true,
                                username: true,
                            },
                        },
                        comments: {
                            orderBy: { createdAt: "asc" },
                            include: {
                                author: {
                                    select: {
                                        userId: true,
                                        firstName: true,
                                        lastName: true,
                                        username: true,
                                    },
                                },
                            },
                        },
                        history: { orderBy: { createdAt: "desc" }, take: 50 },
                    },
                },
            },
        });
        if (!row) throw moneyErr(404, "Case not found");
        const timeline = await listBpTimeline(caseId);
        const serialized = serializeCase(row, actor) as any;
        serialized.tasks = row.tasks.map((t) => ({
            ...t,
            assigneeName: t.assignee ? actorNameFromUser(t.assignee) : null,
            isOverdue:
                (t.status === "OPEN" || t.status === "IN_PROGRESS") &&
                t.deadlineAt &&
                new Date(t.deadlineAt).getTime() < Date.now(),
            comments: t.comments.map((c) => ({
                ...c,
                authorName: actorNameFromUser(c.author),
            })),
        }));
        serialized.documents = row.documents.map((d) => ({
            documentId: d.documentId,
            docKind: d.docKind,
            fileName: d.fileName,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            createdAt: d.createdAt,
            uploadedByUserId: d.uploadedByUserId,
            url: `/api/big-problems/documents/${d.documentId}/download`,
        }));
        serialized.communications = row.communications.map((c) => ({
            communicationId: c.communicationId,
            channel: c.channel,
            subject: c.subject,
            body: c.body,
            createdAt: c.createdAt,
            authorUserId: c.authorUserId,
            authorName: actorNameFromUser(c.author),
        }));
        serialized.timeline = timeline;
        serialized.permissions = {
            canEdit: canEditBigProblemCase(actor.role),
            canClose: canCloseBigProblemCase(actor.role),
            canEditFinancials: canEditBigProblemFinancials(actor.role),
            canViewFinancials: canViewBigProblemFinancials(actor.role),
            canAssignTasks: canAssignBigProblemTasks(actor.role),
            canManageAllTasks: isBpOpsLead(actor.role),
        };
        return serialized;
    }

    async createCase(
        actor: BpActor,
        body: {
            title?: string;
            description?: string;
            category?: string;
            severity?: string;
            incidentDate?: string | null;
            responsibleManagerId?: string | null;
            brokerUserId?: string | null;
            customerId?: string | null;
            carrierId?: string | null;
            carrierName?: string | null;
            shipmentLeadId?: string | null;
            shipmentRef?: string | null;
        }
    ) {
        if (!canCreateBigProblemCase(actor.role)) {
            throw moneyErr(403, "Only Owner / Manager / Team Lead may create Big Problems");
        }
        const title = String(body.title || "").trim();
        if (!title) throw moneyErr(400, "Title is required");
        const category = String(body.category || "OTHER").toUpperCase();
        if (!BP_CATEGORIES.includes(category as any)) {
            throw moneyErr(400, "Invalid category");
        }
        const severity = String(body.severity || "MEDIUM").toUpperCase();
        if (!BP_SEVERITIES.includes(severity as any)) {
            throw moneyErr(400, "Invalid severity");
        }

        const profile = await loadActorProfile(actor);
        const caseNumber = await allocateBigProblemCaseNumber();

        let shipmentRef = body.shipmentRef || null;
        if (body.shipmentLeadId) {
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: body.shipmentLeadId },
                select: {
                    shipmentLeadId: true,
                    greenOsShipmentId: true,
                    loadNumber: true,
                },
            });
            if (!lead) throw moneyErr(400, "Shipment not found");
            shipmentRef = lead.greenOsShipmentId || lead.loadNumber || shipmentRef;
        }

        if (body.carrierId && !body.carrierName) {
            try {
                const carrier = await prisma.carrier.findUnique({
                    where: { carrierId: body.carrierId },
                    select: { legalName: true, dbaName: true },
                });
                if (carrier) {
                    body.carrierName = carrier.dbaName || carrier.legalName;
                }
            } catch {
                /* carrier model may be unavailable on older postgres schemas */
            }
        }

        const created = await prisma.bigProblemCase.create({
            data: {
                caseNumber,
                title,
                description: body.description?.trim() || null,
                category,
                severity,
                status: "OPEN",
                incidentDate: body.incidentDate ? new Date(body.incidentDate) : null,
                responsibleManagerId: body.responsibleManagerId || actor.userId,
                brokerUserId: body.brokerUserId || null,
                customerId: body.customerId || null,
                carrierId: body.carrierId || null,
                carrierName: body.carrierName || null,
                shipmentLeadId: body.shipmentLeadId || null,
                shipmentRef,
                createdByUserId: actor.userId,
                financials: {
                    create: computeBigProblemFinancials({}),
                },
            },
            include: caseInclude,
        });

        await recordBpTimeline({
            caseId: created.caseId,
            eventType: "CASE_CREATED",
            summary: `Created ${caseNumber}: ${title}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: { category, severity },
        });

        const notifyIds = [
            created.responsibleManagerId,
            created.brokerUserId,
        ].filter((id) => id && id !== actor.userId) as string[];
        await notifyUsers({
            userIds: notifyIds,
            title: `Big Problem ${caseNumber}`,
            message: title,
            meta: { caseId: created.caseId, caseNumber },
            shipmentLeadId: created.shipmentLeadId,
        });

        return serializeCase(created, actor);
    }

    async updateCase(actor: BpActor, caseId: string, body: Record<string, unknown>) {
        if (!canEditBigProblemCase(actor.role)) {
            throw moneyErr(403, "Insufficient permissions to edit case");
        }
        await assertCaseAccess(actor, caseId);
        const existing = await prisma.bigProblemCase.findUnique({ where: { caseId } });
        if (!existing) throw moneyErr(404, "Case not found");
        if (existing.status === "CLOSED") {
            throw moneyErr(400, "Reopen the case before editing");
        }

        const data: any = {};
        const changes: Record<string, { from: unknown; to: unknown }> = {};

        const setField = (key: string, value: unknown) => {
            if (value === undefined) return;
            const prev = (existing as any)[key];
            if (String(prev ?? "") !== String(value ?? "")) {
                changes[key] = { from: prev, to: value };
            }
            data[key] = value;
        };

        if (body.title !== undefined) {
            const title = String(body.title || "").trim();
            if (!title) throw moneyErr(400, "Title is required");
            setField("title", title);
        }
        if (body.description !== undefined) {
            setField("description", String(body.description || "").trim() || null);
        }
        if (body.category !== undefined) {
            const category = String(body.category).toUpperCase();
            if (!BP_CATEGORIES.includes(category as any)) throw moneyErr(400, "Invalid category");
            setField("category", category);
        }
        if (body.severity !== undefined) {
            const severity = String(body.severity).toUpperCase();
            if (!BP_SEVERITIES.includes(severity as any)) throw moneyErr(400, "Invalid severity");
            setField("severity", severity);
        }
        if (body.status !== undefined) {
            const status = String(body.status).toUpperCase();
            if (!BP_CASE_STATUSES.includes(status as any) || status === "CLOSED") {
                throw moneyErr(400, "Invalid status (use close/reopen endpoints for closure)");
            }
            setField("status", status);
        }
        if (body.incidentDate !== undefined) {
            setField("incidentDate", body.incidentDate ? new Date(String(body.incidentDate)) : null);
        }
        if (body.responsibleManagerId !== undefined) {
            setField("responsibleManagerId", body.responsibleManagerId || null);
        }
        if (body.brokerUserId !== undefined) setField("brokerUserId", body.brokerUserId || null);
        if (body.customerId !== undefined) setField("customerId", body.customerId || null);
        if (body.carrierId !== undefined) setField("carrierId", body.carrierId || null);
        if (body.carrierName !== undefined) {
            setField("carrierName", body.carrierName ? String(body.carrierName) : null);
        }
        if (body.shipmentLeadId !== undefined) {
            setField("shipmentLeadId", body.shipmentLeadId || null);
        }
        if (body.shipmentRef !== undefined) {
            setField("shipmentRef", body.shipmentRef ? String(body.shipmentRef) : null);
        }
        if (body.resolutionSummary !== undefined) {
            setField(
                "resolutionSummary",
                body.resolutionSummary ? String(body.resolutionSummary) : null
            );
        }

        if (!Object.keys(data).length) {
            return this.getCase(actor, caseId);
        }

        const profile = await loadActorProfile(actor);
        const updated = await prisma.bigProblemCase.update({
            where: { caseId },
            data,
            include: caseInclude,
        });

        if (changes.status) {
            await recordBpTimeline({
                caseId,
                eventType: changes.status.to === "RESOLVED" ? "RESOLVED" : "STATUS_CHANGED",
                summary: `Status ${changes.status.from} → ${changes.status.to}`,
                actorUserId: actor.userId,
                actorName: profile.name,
                details: changes,
            });
        } else {
            await recordBpTimeline({
                caseId,
                eventType: "CASE_UPDATED",
                summary: `Case updated (${Object.keys(changes).join(", ")})`,
                actorUserId: actor.userId,
                actorName: profile.name,
                details: changes,
            });
        }

        return serializeCase(updated, actor);
    }

    async closeCase(actor: BpActor, caseId: string, resolutionSummary?: string) {
        if (!canCloseBigProblemCase(actor.role)) {
            throw moneyErr(403, "Insufficient permissions to close case");
        }
        await assertCaseAccess(actor, caseId);
        const profile = await loadActorProfile(actor);
        const updated = await prisma.bigProblemCase.update({
            where: { caseId },
            data: {
                status: "CLOSED",
                closedAt: new Date(),
                closedByUserId: actor.userId,
                resolutionSummary: resolutionSummary?.trim() || undefined,
            },
            include: caseInclude,
        });
        await recordBpTimeline({
            caseId,
            eventType: "CLOSED",
            summary: "Case closed",
            actorUserId: actor.userId,
            actorName: profile.name,
            details: { resolutionSummary },
        });
        return serializeCase(updated, actor);
    }

    async reopenCase(actor: BpActor, caseId: string) {
        if (!canCloseBigProblemCase(actor.role)) {
            throw moneyErr(403, "Insufficient permissions to reopen case");
        }
        await assertCaseAccess(actor, caseId);
        const profile = await loadActorProfile(actor);
        const updated = await prisma.bigProblemCase.update({
            where: { caseId },
            data: {
                status: "REOPENED",
                closedAt: null,
                closedByUserId: null,
            },
            include: caseInclude,
        });
        await recordBpTimeline({
            caseId,
            eventType: "REOPENED",
            summary: "Case reopened",
            actorUserId: actor.userId,
            actorName: profile.name,
        });
        return serializeCase(updated, actor);
    }

    async updateFinancials(actor: BpActor, caseId: string, body: Record<string, unknown>) {
        if (!canEditBigProblemFinancials(actor.role)) {
            throw moneyErr(403, "No financial edit permission");
        }
        await assertCaseAccess(actor, caseId);
        const computed = computeBigProblemFinancials({
            customerClaimAmount: body.customerClaimAmount as number,
            carrierClaimAmount: body.carrierClaimAmount as number,
            insuranceClaimAmount: body.insuranceClaimAmount as number,
            insuranceStatus: body.insuranceStatus as string,
            customerCompensation: body.customerCompensation as number,
            legalExpenses: body.legalExpenses as number,
            otherExpenses: body.otherExpenses as number,
            amountRecovered: body.amountRecovered as number,
        });

        // Pending insurance must not be treated as recovered.
        if (
            (computed.insuranceStatus === "PENDING" || computed.insuranceStatus === "APPROVED") &&
            body.includePendingInsuranceAsRecovered
        ) {
            throw moneyErr(400, "Pending insurance cannot count as recovered funds");
        }

        const profile = await loadActorProfile(actor);
        const row = await prisma.bigProblemFinancials.upsert({
            where: { caseId },
            create: {
                caseId,
                ...computed,
                notes: body.notes ? String(body.notes) : null,
                updatedByUserId: actor.userId,
            },
            update: {
                ...computed,
                notes: body.notes !== undefined ? String(body.notes || "") || null : undefined,
                updatedByUserId: actor.userId,
            },
        });

        await recordBpTimeline({
            caseId,
            eventType: "FINANCIAL_CHANGED",
            summary: `Financials updated — outstanding $${computed.outstandingExposure.toFixed(2)}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: computed as any,
        });

        return row;
    }

    async createTask(
        actor: BpActor,
        caseId: string,
        body: {
            title?: string;
            description?: string;
            priority?: string;
            assigneeUserId?: string | null;
            deadlineAt?: string | null;
        }
    ) {
        if (!canAssignBigProblemTasks(actor.role) && !isBpOpsLead(actor.role)) {
            throw moneyErr(403, "Insufficient permissions to create tasks");
        }
        await assertCaseAccess(actor, caseId);
        const title = String(body.title || "").trim();
        if (!title) throw moneyErr(400, "Task title is required");
        const priority = String(body.priority || "MEDIUM").toUpperCase();
        if (!BP_TASK_PRIORITIES.includes(priority as any)) {
            throw moneyErr(400, "Invalid priority");
        }
        const profile = await loadActorProfile(actor);
        const task = await prisma.bigProblemTask.create({
            data: {
                caseId,
                title,
                description: body.description?.trim() || null,
                priority,
                status: "OPEN",
                assigneeUserId: body.assigneeUserId || null,
                deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : null,
                createdByUserId: actor.userId,
                history: {
                    create: {
                        actorUserId: actor.userId,
                        action: "CREATED",
                        newValue: title,
                    },
                },
            },
        });

        await refreshNextDeadline(caseId);
        await recordBpTimeline({
            caseId,
            eventType: body.assigneeUserId ? "TASK_ASSIGNED" : "TASK_CREATED",
            summary: `Task created: ${title}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: {
                taskId: task.taskId,
                assigneeUserId: body.assigneeUserId,
                deadlineAt: body.deadlineAt,
            },
        });

        if (body.assigneeUserId && body.assigneeUserId !== actor.userId) {
            const cse = await prisma.bigProblemCase.findUnique({
                where: { caseId },
                select: { caseNumber: true, shipmentLeadId: true },
            });
            await notifyUsers({
                userIds: [body.assigneeUserId],
                title: `Task assigned — ${cse?.caseNumber || caseId}`,
                message: title,
                meta: { caseId, taskId: task.taskId },
                shipmentLeadId: cse?.shipmentLeadId,
            });
        }

        return task;
    }

    async updateTask(actor: BpActor, taskId: string, body: Record<string, unknown>) {
        const task = await prisma.bigProblemTask.findUnique({
            where: { taskId },
            include: { case: true },
        });
        if (!task) throw moneyErr(404, "Task not found");
        await assertCaseAccess(actor, task.caseId);

        const isAssignee = task.assigneeUserId === actor.userId;
        const canManage = isBpOpsLead(actor.role);
        if (!canManage && !isAssignee && !isBpBroker(actor.role) && actor.role !== Roles.Accounting) {
            throw moneyErr(403, "Insufficient permissions for this task");
        }

        // Brokers/Accounting may only complete/comment their own tasks — not reassign freely.
        if (!canManage) {
            if (body.assigneeUserId !== undefined && body.assigneeUserId !== task.assigneeUserId) {
                throw moneyErr(403, "Cannot reassign tasks");
            }
            if (body.deadlineAt !== undefined) {
                throw moneyErr(403, "Cannot change deadlines");
            }
            if (body.priority !== undefined) {
                throw moneyErr(403, "Cannot change priority");
            }
        }

        const data: any = {};
        const history: { action: string; fieldName?: string; oldValue?: string; newValue?: string }[] =
            [];

        if (body.title !== undefined && canManage) {
            const title = String(body.title || "").trim();
            if (!title) throw moneyErr(400, "Title required");
            if (title !== task.title) {
                history.push({
                    action: "UPDATED",
                    fieldName: "title",
                    oldValue: task.title,
                    newValue: title,
                });
                data.title = title;
            }
        }
        if (body.description !== undefined && canManage) {
            data.description = String(body.description || "").trim() || null;
        }
        if (body.priority !== undefined && canManage) {
            const priority = String(body.priority).toUpperCase();
            if (!BP_TASK_PRIORITIES.includes(priority as any)) {
                throw moneyErr(400, "Invalid priority");
            }
            if (priority !== task.priority) {
                history.push({
                    action: "UPDATED",
                    fieldName: "priority",
                    oldValue: task.priority,
                    newValue: priority,
                });
                data.priority = priority;
            }
        }
        if (body.assigneeUserId !== undefined && canManage) {
            const next = (body.assigneeUserId as string) || null;
            if (next !== task.assigneeUserId) {
                history.push({
                    action: "ASSIGNED",
                    fieldName: "assigneeUserId",
                    oldValue: task.assigneeUserId || "",
                    newValue: next || "",
                });
                data.assigneeUserId = next;
            }
        }
        if (body.deadlineAt !== undefined && canManage) {
            const next = body.deadlineAt ? new Date(String(body.deadlineAt)) : null;
            const prev = task.deadlineAt?.toISOString() || "";
            const nextS = next?.toISOString() || "";
            if (prev !== nextS) {
                history.push({
                    action: "DEADLINE_CHANGED",
                    fieldName: "deadlineAt",
                    oldValue: prev,
                    newValue: nextS,
                });
                data.deadlineAt = next;
            }
        }
        if (body.status !== undefined) {
            const status = String(body.status).toUpperCase();
            if (!BP_TASK_STATUSES.includes(status as any)) {
                throw moneyErr(400, "Invalid task status");
            }
            if (!canManage && !isAssignee) {
                throw moneyErr(403, "Only assignee or ops lead may change task status");
            }
            if (status !== task.status) {
                history.push({
                    action: status === "COMPLETED" ? "COMPLETED" : status === "CANCELLED" ? "CANCELLED" : "UPDATED",
                    fieldName: "status",
                    oldValue: task.status,
                    newValue: status,
                });
                data.status = status;
                if (status === "COMPLETED") data.completedAt = new Date();
                if (status === "CANCELLED") data.cancelledAt = new Date();
                if (status === "OPEN" || status === "IN_PROGRESS") {
                    data.completedAt = null;
                    data.cancelledAt = null;
                }
            }
        }

        if (!Object.keys(data).length) return task;

        const profile = await loadActorProfile(actor);
        const updated = await prisma.bigProblemTask.update({
            where: { taskId },
            data: {
                ...data,
                history: {
                    create: history.map((h) => ({
                        actorUserId: actor.userId,
                        action: h.action,
                        fieldName: h.fieldName,
                        oldValue: h.oldValue,
                        newValue: h.newValue,
                    })),
                },
            },
        });

        await refreshNextDeadline(task.caseId);

        const eventType =
            data.status === "COMPLETED"
                ? "TASK_COMPLETED"
                : data.status === "CANCELLED"
                  ? "TASK_CANCELLED"
                  : data.deadlineAt !== undefined
                    ? "DEADLINE_CHANGED"
                    : data.assigneeUserId !== undefined
                      ? "TASK_ASSIGNED"
                      : "TASK_UPDATED";

        await recordBpTimeline({
            caseId: task.caseId,
            eventType,
            summary: `Task ${updated.title}: ${history.map((h) => h.action).join(", ")}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: { taskId, history },
        });

        if (data.assigneeUserId && data.assigneeUserId !== actor.userId) {
            await notifyUsers({
                userIds: [data.assigneeUserId],
                title: `Task assigned — ${task.case.caseNumber}`,
                message: updated.title,
                meta: { caseId: task.caseId, taskId },
                shipmentLeadId: task.case.shipmentLeadId,
            });
        }

        return updated;
    }

    async addTaskComment(actor: BpActor, taskId: string, bodyText: string) {
        const task = await prisma.bigProblemTask.findUnique({ where: { taskId } });
        if (!task) throw moneyErr(404, "Task not found");
        await assertCaseAccess(actor, task.caseId);
        const text = String(bodyText || "").trim();
        if (!text) throw moneyErr(400, "Comment required");
        const profile = await loadActorProfile(actor);
        const comment = await prisma.bigProblemTaskComment.create({
            data: {
                taskId,
                authorUserId: actor.userId,
                body: text,
            },
        });
        await prisma.bigProblemTaskHistory.create({
            data: {
                taskId,
                actorUserId: actor.userId,
                action: "COMMENT",
                newValue: text.slice(0, 500),
            },
        });
        await recordBpTimeline({
            caseId: task.caseId,
            eventType: "COMMENT_ADDED",
            summary: `Comment on task: ${task.title}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: { taskId, commentId: comment.commentId },
        });
        return comment;
    }

    async myTasks(actor: BpActor) {
        const where: any = {
            assigneeUserId: actor.userId,
            status: { in: ["OPEN", "IN_PROGRESS"] },
        };
        if (isBpBroker(actor.role)) {
            where.case = brokerCaseVisibilityFilter(actor.userId);
        }
        const tasks = await prisma.bigProblemTask.findMany({
            where,
            include: {
                case: {
                    select: {
                        caseId: true,
                        caseNumber: true,
                        title: true,
                        severity: true,
                        status: true,
                    },
                },
            },
            orderBy: [{ deadlineAt: "asc" }, { priority: "desc" }],
            take: 200,
        });
        const now = Date.now();
        return {
            items: tasks.map((t) => ({
                ...t,
                isOverdue: t.deadlineAt ? new Date(t.deadlineAt).getTime() < now : false,
            })),
        };
    }

    async deadlines(actor: BpActor) {
        const caseFilter = isBpBroker(actor.role)
            ? brokerCaseVisibilityFilter(actor.userId)
            : {};
        const tasks = await prisma.bigProblemTask.findMany({
            where: {
                status: { in: ["OPEN", "IN_PROGRESS"] },
                deadlineAt: { not: null },
                case: caseFilter,
            },
            include: {
                case: {
                    select: {
                        caseId: true,
                        caseNumber: true,
                        title: true,
                        severity: true,
                    },
                },
                assignee: {
                    select: { userId: true, firstName: true, lastName: true, username: true },
                },
            },
            orderBy: { deadlineAt: "asc" },
            take: 300,
        });
        const now = Date.now();
        return {
            items: tasks.map((t) => ({
                taskId: t.taskId,
                title: t.title,
                priority: t.priority,
                status: t.status,
                deadlineAt: t.deadlineAt,
                isOverdue: t.deadlineAt ? new Date(t.deadlineAt).getTime() < now : false,
                assigneeName: t.assignee ? actorNameFromUser(t.assignee) : null,
                caseId: t.case.caseId,
                caseNumber: t.case.caseNumber,
                caseTitle: t.case.title,
                severity: t.case.severity,
            })),
        };
    }

    async financialExposure(actor: BpActor) {
        if (!canViewBigProblemFinancials(actor.role)) {
            throw moneyErr(403, "Financial access denied");
        }
        const cases = await prisma.bigProblemCase.findMany({
            where: { status: { not: "CLOSED" } },
            include: {
                financials: true,
                customer: { select: { companyName: true } },
            },
            orderBy: { updatedAt: "desc" },
        });
        const items = cases
            .filter((c) => c.financials && c.financials.outstandingExposure > 0)
            .map((c) => ({
                caseId: c.caseId,
                caseNumber: c.caseNumber,
                title: c.title,
                severity: c.severity,
                status: c.status,
                customerName: c.customer?.companyName || null,
                potentialExposure: c.financials!.potentialExposure,
                amountRecovered: c.financials!.amountRecovered,
                outstandingExposure: c.financials!.outstandingExposure,
                actualNetLoss: c.financials!.actualNetLoss,
                insuranceStatus: c.financials!.insuranceStatus,
            }));
        const total = items.reduce((s, i) => s + i.outstandingExposure, 0);
        return { items, totalOutstanding: Math.round(total * 100) / 100 };
    }

    async addCommunication(
        actor: BpActor,
        caseId: string,
        body: { channel?: string; subject?: string; body?: string }
    ) {
        await assertCaseAccess(actor, caseId);
        const text = String(body.body || "").trim();
        if (!text) throw moneyErr(400, "Message body required");
        const channel = String(body.channel || "NOTE").toUpperCase();
        if (!BP_COMM_CHANNELS.includes(channel as any)) {
            throw moneyErr(400, "Invalid channel");
        }
        const profile = await loadActorProfile(actor);
        const row = await prisma.bigProblemCommunication.create({
            data: {
                caseId,
                channel,
                subject: body.subject?.trim() || null,
                body: text,
                authorUserId: actor.userId,
            },
        });
        await recordBpTimeline({
            caseId,
            eventType: "COMMUNICATION_ADDED",
            summary: `${channel}: ${body.subject || text.slice(0, 80)}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: { communicationId: row.communicationId },
        });
        return row;
    }

    async uploadDocument(
        actor: BpActor,
        caseId: string,
        file: {
            originalName: string;
            mimeType: string;
            size: number;
            tempPath: string;
        },
        docKind?: string
    ) {
        await assertCaseAccess(actor, caseId);
        const kind = String(docKind || "GENERAL").toUpperCase();
        if (!BP_DOC_KINDS.includes(kind as any)) throw moneyErr(400, "Invalid document kind");
        if (kind === "FINANCIAL" && !canViewBigProblemFinancials(actor.role)) {
            throw moneyErr(403, "Cannot upload financial documents");
        }

        const id = randomUUID();
        const safe = String(file.originalName || "file")
            .replace(/[^\w.\- ()[\]]+/g, "_")
            .slice(0, 120);
        const storedName = `${id}-${safe}`;
        const dir = path.join(BP_UPLOADS_ROOT, caseId);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, storedName);
        fs.renameSync(file.tempPath, dest);

        const profile = await loadActorProfile(actor);
        const doc = await prisma.bigProblemDocument.create({
            data: {
                caseId,
                docKind: kind,
                fileName: file.originalName || safe,
                mimeType: file.mimeType || "application/octet-stream",
                sizeBytes: file.size || 0,
                storedName,
                storagePath: dest,
                uploadedByUserId: actor.userId,
            },
        });

        await recordBpTimeline({
            caseId,
            eventType: "DOCUMENT_UPLOADED",
            summary: `Uploaded ${doc.fileName}`,
            actorUserId: actor.userId,
            actorName: profile.name,
            details: { documentId: doc.documentId, docKind: kind },
        });

        return {
            documentId: doc.documentId,
            fileName: doc.fileName,
            docKind: doc.docKind,
            url: `/api/big-problems/documents/${doc.documentId}/download`,
            createdAt: doc.createdAt,
        };
    }

    async resolveDocumentDownload(actor: BpActor, documentId: string) {
        const doc = await prisma.bigProblemDocument.findUnique({ where: { documentId } });
        if (!doc) throw moneyErr(404, "Document not found");
        await assertCaseAccess(actor, doc.caseId);
        if (doc.docKind === "FINANCIAL" && !canViewBigProblemFinancials(actor.role)) {
            throw moneyErr(403, "Financial document access denied");
        }
        if (!fs.existsSync(doc.storagePath)) throw moneyErr(404, "File missing on disk");
        return doc;
    }

    /** Mark overdue open tasks and notify assignees once. */
    async processOverdueTaskReminders(limit = 80): Promise<number> {
        const now = new Date();
        const overdue = await prisma.bigProblemTask.findMany({
            where: {
                status: { in: ["OPEN", "IN_PROGRESS"] },
                deadlineAt: { lt: now },
                overdueNotifiedAt: null,
                assigneeUserId: { not: null },
            },
            include: {
                case: { select: { caseId: true, caseNumber: true, shipmentLeadId: true } },
            },
            take: limit,
        });
        let n = 0;
        for (const task of overdue) {
            await prisma.bigProblemTask.update({
                where: { taskId: task.taskId },
                data: { overdueNotifiedAt: now },
            });
            if (task.assigneeUserId) {
                await notifyUsers({
                    userIds: [task.assigneeUserId],
                    title: `Overdue task — ${task.case.caseNumber}`,
                    message: task.title,
                    meta: { caseId: task.caseId, taskId: task.taskId, overdue: true },
                    shipmentLeadId: task.case.shipmentLeadId,
                });
            }
            n += 1;
        }
        return n;
    }
}

export const bigProblemsService = new BigProblemsService();

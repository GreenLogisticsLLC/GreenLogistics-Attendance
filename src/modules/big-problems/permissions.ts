import { Roles } from "../../auth/roles.js";

export type BpActor = {
    userId: string;
    role: string;
};

/** Owner / Admin / Manager / Team Lead — full case management. */
export function isBpOpsLead(role: string | null | undefined): boolean {
    return (
        role === Roles.Owner ||
        role === Roles.Administrator ||
        role === Roles.Manager ||
        role === Roles.TeamLead
    );
}

export function isBpAccounting(role: string | null | undefined): boolean {
    return role === Roles.Accounting;
}

export function isBpBroker(role: string | null | undefined): boolean {
    return role === Roles.Broker;
}

/** May open the Big Problems module at all. */
export function canAccessBigProblemsModule(role: string | null | undefined): boolean {
    return isBpOpsLead(role) || isBpAccounting(role) || isBpBroker(role);
}

export function canCreateBigProblemCase(role: string | null | undefined): boolean {
    return isBpOpsLead(role);
}

export function canEditBigProblemCase(role: string | null | undefined): boolean {
    return isBpOpsLead(role);
}

export function canCloseBigProblemCase(role: string | null | undefined): boolean {
    return isBpOpsLead(role);
}

export function canEditBigProblemFinancials(role: string | null | undefined): boolean {
    return isBpOpsLead(role) || isBpAccounting(role);
}

export function canViewBigProblemFinancials(role: string | null | undefined): boolean {
    return isBpOpsLead(role) || isBpAccounting(role);
}

export function canManageAllBigProblemTasks(role: string | null | undefined): boolean {
    return isBpOpsLead(role);
}

export function canAssignBigProblemTasks(role: string | null | undefined): boolean {
    return isBpOpsLead(role);
}

/** Broker / Accounting may complete their own assigned tasks and add comments/docs. */
export function canUploadBigProblemDocuments(role: string | null | undefined): boolean {
    return canAccessBigProblemsModule(role);
}

export function canAddBigProblemComments(role: string | null | undefined): boolean {
    return canAccessBigProblemsModule(role);
}

export type BpCaseAccessShape = {
    responsibleManagerId?: string | null;
    brokerUserId?: string | null;
    createdByUserId?: string | null;
    taskAssigneeIds?: string[];
};

/**
 * Case visibility:
 * - Ops leads: all cases
 * - Accounting: all cases (financials gated separately)
 * - Broker: only participant (broker on case, manager, creator) or assigned to a task
 */
export function canViewBigProblemCase(actor: BpActor, caseRow: BpCaseAccessShape): boolean {
    if (isBpOpsLead(actor.role) || isBpAccounting(actor.role)) return true;
    if (!isBpBroker(actor.role)) return false;
    if (caseRow.brokerUserId === actor.userId) return true;
    if (caseRow.responsibleManagerId === actor.userId) return true;
    if (caseRow.createdByUserId === actor.userId) return true;
    if ((caseRow.taskAssigneeIds || []).includes(actor.userId)) return true;
    return false;
}

export function brokerCaseVisibilityFilter(userId: string) {
    return {
        OR: [
            { brokerUserId: userId },
            { responsibleManagerId: userId },
            { createdByUserId: userId },
            { tasks: { some: { assigneeUserId: userId } } },
        ],
    };
}

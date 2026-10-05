import { Roles, type RoleName } from "./roles.js";
import {
    accountingSubRoleFromPosition,
    type AccountingSubRole,
} from "./accounting.js";

/** Roles that appear as badge Position and get Green OS module access when set. */
export const BADGE_POSITION_ROLES = [
    Roles.Broker,
    Roles.TeamLead,
    Roles.Accounting,
    Roles.Manager,
] as const;

export type BadgePositionRole = (typeof BADGE_POSITION_ROLES)[number];

const POSITION_ALIASES: Record<string, BadgePositionRole> = {
    broker: Roles.Broker,
    "team lead": Roles.TeamLead,
    teamlead: Roles.TeamLead,
    "team-lead": Roles.TeamLead,
    tl: Roles.TeamLead,
    accounting: Roles.Accounting,
    "accounting documents": Roles.Accounting,
    "accounting document": Roles.Accounting,
    "accounting payments": Roles.Accounting,
    "accounting payment": Roles.Accounting,
    account: Roles.Accounting,
    accountant: Roles.Accounting,
    accaunting: Roles.Accounting,
    manager: Roles.Manager,
    operations: Roles.Manager,
};

/** Map free-text / select Position → canonical role name, or null if not a platform role. */
export function roleFromPosition(position: string | null | undefined): BadgePositionRole | null {
    if (!position) return null;
    const raw = String(position).trim();
    if (!raw) return null;
    for (const role of BADGE_POSITION_ROLES) {
        if (role.toLowerCase() === raw.toLowerCase()) return role;
    }
    const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
    return (
        POSITION_ALIASES[key] ||
        POSITION_ALIASES[key.replace(/[\s_-]+/g, "")] ||
        null
    );
}

/**
 * When Position maps to Accounting, also resolve DOCUMENTS | PAYMENTS.
 * Non-Accounting positions return null.
 */
export function accountingSubRoleFromBadgePosition(
    position: string | null | undefined
): AccountingSubRole | null {
    if (roleFromPosition(position) !== Roles.Accounting) return null;
    return accountingSubRoleFromPosition(position);
}

export function isBadgePositionRole(value: string): value is BadgePositionRole {
    return (BADGE_POSITION_ROLES as readonly string[]).includes(value);
}

export function isKnownBadgePosition(position: string | null | undefined): boolean {
    return roleFromPosition(position) !== null;
}

/** Re-export for callers that only need RoleName typing. */
export type { RoleName };

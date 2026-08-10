/**
 * GreenOS role architecture — extend roles here without rewriting modules.
 * Frontend registry `roles` arrays should stay aligned with MODULE_ACCESS.
 */

export const Roles = {
    Administrator: "Administrator",
    Owner: "Owner",
    Manager: "Manager",
    TeamLead: "Team Lead",
    Broker: "Broker",
    Dispatcher: "Dispatcher",
    HR: "HR",
    Accounting: "Accounting",
    Viewer: "Viewer",
} as const;

export type RoleName = (typeof Roles)[keyof typeof Roles];

/** Roles that may self-register (approval email → Owner inbox). */
export const SIGNUP_ROLE_NAMES = [
    Roles.Broker,
    Roles.TeamLead,
    Roles.Manager,
    Roles.Owner,
] as const;

export type SignupRoleName = (typeof SIGNUP_ROLE_NAMES)[number];

export const ROLE_DESCRIPTIONS: Record<string, string> = {
    [Roles.Administrator]: "Full system access",
    [Roles.Owner]: "Company owner — full access",
    [Roles.Manager]: "Operations manager — company-wide CRM and assignment",
    [Roles.TeamLead]: "Team lead — team shipments and broker oversight",
    [Roles.Broker]: "Broker — only own shipments and personal workspace",
    [Roles.Dispatcher]: "Dispatcher — loads and carriers (future)",
    [Roles.HR]: "HR — employees and attendance (future)",
    [Roles.Accounting]: "Accounting — Load money, invoices, and profit (Customer − Carrier)",
    [Roles.Viewer]: "Read-only access",
};

/** Module ids from GreenOSRegistry / broker shell. */
export type ModuleId =
    | "dashboard"
    | "broker"
    | "crm"
    | "email"
    | "assignment"
    | "dispatch"
    | "loads"
    | "trucking"
    | "car-transport"
    | "employees"
    | "attendance"
    | "accounting"
    | "invoices"
    | "contracts"
    | "documents"
    | "communications"
    | "reports"
    | "ai"
    | "administration"
    | "carriers";

const ALL_MODULES: ModuleId[] = [
    "dashboard",
    "broker",
    "crm",
    "email",
    "assignment",
    "dispatch",
    "loads",
    "trucking",
    "car-transport",
    "carriers",
    "employees",
    "attendance",
    "accounting",
    "invoices",
    "contracts",
    "documents",
    "communications",
    "reports",
    "ai",
    "administration",
];

/**
 * Which shell modules each role may open.
 * Omit a role from a module → denied. Empty list → nobody (unused).
 */
export const MODULE_ACCESS: Record<ModuleId, RoleName[]> = {
    dashboard: [
        Roles.Administrator,
        Roles.Owner,
        Roles.Manager,
        Roles.TeamLead,
        Roles.Accounting,
        Roles.Dispatcher,
        Roles.HR,
        Roles.Viewer,
    ],
    // Broker-only personal shell
    broker: [Roles.Broker],
    crm: [
        Roles.Administrator,
        Roles.Owner,
        Roles.Manager,
        Roles.TeamLead,
        Roles.Accounting,
        Roles.Dispatcher,
    ],
    email: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.TeamLead],
    assignment: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.TeamLead],
    dispatch: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Dispatcher, Roles.Broker, Roles.TeamLead],
    loads: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Dispatcher, Roles.Broker, Roles.TeamLead],
    trucking: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Dispatcher, Roles.Broker, Roles.TeamLead],
    carriers: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Dispatcher, Roles.Broker, Roles.TeamLead],
    "car-transport": [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Dispatcher],
    employees: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.HR],
    attendance: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.HR, Roles.TeamLead],
    accounting: [Roles.Administrator, Roles.Owner, Roles.Accounting],
    invoices: [Roles.Administrator, Roles.Owner, Roles.Accounting],
    contracts: [Roles.Administrator, Roles.Owner, Roles.Manager],
    documents: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Dispatcher, Roles.Accounting],
    communications: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.TeamLead],
    reports: [Roles.Administrator, Roles.Owner, Roles.Manager, Roles.Accounting, Roles.TeamLead],
    ai: [
        Roles.Administrator,
        Roles.Owner,
        Roles.Manager,
        Roles.TeamLead,
        Roles.Broker,
        Roles.Dispatcher,
        Roles.HR,
        Roles.Accounting,
    ],
    administration: [Roles.Administrator, Roles.Owner],
};

export function isKnownRole(role: string): role is RoleName {
    return Object.values(Roles).includes(role as RoleName);
}

/** Broker (and future similar) may only see own assigned data. */
export function isDataScopedRole(role: string): boolean {
    return role === Roles.Broker;
}

/** Team Lead sees only their brokers' work (not company-wide). */
export function isTeamScopedRole(role: string): boolean {
    return role === Roles.TeamLead;
}

export function canAccessModule(role: string, moduleId: string): boolean {
    const allowed = MODULE_ACCESS[moduleId as ModuleId];
    if (!allowed) return false;
    return allowed.includes(role as RoleName);
}

export function defaultModuleForRole(role: string): ModuleId {
    if (role === Roles.Broker) return "broker";
    if (role === Roles.TeamLead) return "crm";
    return "dashboard";
}

export function modulesForRole(role: string): ModuleId[] {
    return ALL_MODULES.filter((m) => canAccessModule(role, m));
}

/** Company-wide shipment visibility (Owner/Manager/Admin). Team Lead is team-scoped. */
export function canViewAllShipments(role: string): boolean {
    return !isDataScopedRole(role) && !isTeamScopedRole(role);
}

/**
 * Load Money / Profit (Customer $ − Carrier $).
 * Only Accounting fills books; Owner (and Admin) may view/edit.
 * Brokers never see this — they run ops docs without P&L.
 */
export function canViewLoadProfit(role: string): boolean {
    return (
        role === Roles.Owner ||
        role === Roles.Accounting ||
        role === Roles.Administrator
    );
}

export function canManageBrokers(role: string): boolean {
    return (
        role === Roles.Administrator ||
        role === Roles.Owner ||
        role === Roles.Manager ||
        role === Roles.TeamLead
    );
}

/** Who can open Employees → Platform users and change account roles. */
export function canManageUserRoles(role: string): boolean {
    return (
        role === Roles.Administrator ||
        role === Roles.Owner ||
        role === Roles.Manager ||
        role === Roles.HR
    );
}

/** Roles that may be assigned in Employees UI (excludes nothing critical). */
export const ASSIGNABLE_ROLE_NAMES: RoleName[] = [
    Roles.Broker,
    Roles.TeamLead,
    Roles.Manager,
    Roles.Owner,
    Roles.Administrator,
    Roles.Dispatcher,
    Roles.HR,
    Roles.Accounting,
    Roles.Viewer,
];

/** Manager/HR may not promote to Owner/Administrator. */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
    if (!canManageUserRoles(actorRole) || !isKnownRole(targetRole)) return false;
    if (targetRole === Roles.Owner || targetRole === Roles.Administrator) {
        return actorRole === Roles.Owner || actorRole === Roles.Administrator;
    }
    return true;
}

/** Same elevation rules as assign — Manager cannot delete Owner/Admin accounts. */
export function canDeleteUserAccount(actorRole: string, targetRole: string): boolean {
    return canAssignRole(actorRole, targetRole);
}

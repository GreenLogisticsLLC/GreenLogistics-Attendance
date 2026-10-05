/**
 * Accounting Team — first-class team identity inside Green OS.
 *
 * Team identity = Roles.Accounting (ONE source of truth — do not add a parallel Team enum).
 * Sub-roles live only under Accounting: DOCUMENTS | PAYMENTS.
 */
import { Roles } from "./roles.js";

export const AccountingSubRoles = {
    Documents: "DOCUMENTS",
    Payments: "PAYMENTS",
} as const;

export type AccountingSubRole =
    (typeof AccountingSubRoles)[keyof typeof AccountingSubRoles];

export const ACCOUNTING_SUB_ROLE_LABELS: Record<AccountingSubRole, string> = {
    DOCUMENTS: "Accounting Documents",
    PAYMENTS: "Accounting Payments",
};

/** Badge / employee Position values that map to Accounting + sub-role. */
export const ACCOUNTING_POSITIONS = {
    Documents: "Accounting Documents",
    Payments: "Accounting Payments",
    Legacy: "Accounting",
} as const;

export const AccountingPermissions = {
    Access: "accounting.access",
    ShipmentsView: "accounting.shipments.view",
    DocumentsView: "accounting.documents.view",
    DocumentsVerify: "accounting.documents.verify",
    DocumentsReject: "accounting.documents.reject",
    FinancialsView: "accounting.financials.view",
    FinancialsVerify: "accounting.financials.verify",
    BillingView: "accounting.billing.view",
    BillingCreate: "accounting.billing.create",
    BillingSend: "accounting.billing.send",
    CustomerPaymentsView: "accounting.customer_payments.view",
    CustomerPaymentsRecord: "accounting.customer_payments.record",
    CarrierPaymentsView: "accounting.carrier_payments.view",
    CarrierPaymentsExecute: "accounting.carrier_payments.execute",
    NotesCreate: "accounting.notes.create",
    AuditView: "accounting.audit.view",
} as const;

export type AccountingPermission =
    (typeof AccountingPermissions)[keyof typeof AccountingPermissions];

const DOCUMENTS_PERMISSIONS: AccountingPermission[] = [
    AccountingPermissions.Access,
    AccountingPermissions.ShipmentsView,
    AccountingPermissions.DocumentsView,
    AccountingPermissions.DocumentsVerify,
    AccountingPermissions.DocumentsReject,
    AccountingPermissions.FinancialsView,
    AccountingPermissions.FinancialsVerify,
    AccountingPermissions.BillingView,
    AccountingPermissions.NotesCreate,
    AccountingPermissions.AuditView,
];

const PAYMENTS_PERMISSIONS: AccountingPermission[] = [
    AccountingPermissions.Access,
    AccountingPermissions.ShipmentsView,
    AccountingPermissions.DocumentsView,
    AccountingPermissions.FinancialsView,
    AccountingPermissions.BillingView,
    AccountingPermissions.BillingCreate,
    AccountingPermissions.BillingSend,
    AccountingPermissions.CustomerPaymentsView,
    AccountingPermissions.CustomerPaymentsRecord,
    AccountingPermissions.CarrierPaymentsView,
    AccountingPermissions.CarrierPaymentsExecute,
    AccountingPermissions.NotesCreate,
    AccountingPermissions.AuditView,
];

/** Owner / Admin have full Accounting control. */
const ADMIN_PERMISSIONS: AccountingPermission[] = Object.values(AccountingPermissions);

export function isAccountingSubRole(value: unknown): value is AccountingSubRole {
    return value === AccountingSubRoles.Documents || value === AccountingSubRoles.Payments;
}

export function normalizeAccountingSubRole(
    value: unknown,
    fallback: AccountingSubRole = AccountingSubRoles.Documents
): AccountingSubRole {
    if (isAccountingSubRole(value)) return value;
    const raw = String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
    if (raw === "DOCUMENTS" || raw === "ACCOUNTING_DOCUMENTS" || raw === "DOCUMENT") {
        return AccountingSubRoles.Documents;
    }
    if (raw === "PAYMENTS" || raw === "ACCOUNTING_PAYMENTS" || raw === "PAYMENT") {
        return AccountingSubRoles.Payments;
    }
    return fallback;
}

/** Map employee Position → Accounting sub-role (null if not an Accounting position). */
export function accountingSubRoleFromPosition(
    position: string | null | undefined
): AccountingSubRole | null {
    if (!position) return null;
    const key = String(position).trim().toLowerCase().replace(/\s+/g, " ");
    if (
        key === "accounting documents" ||
        key === "accounting document" ||
        key === "documents" ||
        key === "accounting_documents"
    ) {
        return AccountingSubRoles.Documents;
    }
    if (
        key === "accounting payments" ||
        key === "accounting payment" ||
        key === "payments" ||
        key === "accounting_payments"
    ) {
        return AccountingSubRoles.Payments;
    }
    if (key === "accounting" || key === "accountant" || key === "account" || key === "accaunting") {
        return AccountingSubRoles.Documents;
    }
    return null;
}

export function positionLabelForAccountingSubRole(sub: AccountingSubRole): string {
    return sub === AccountingSubRoles.Payments
        ? ACCOUNTING_POSITIONS.Payments
        : ACCOUNTING_POSITIONS.Documents;
}

export function isAccountingTeam(role: string | null | undefined): boolean {
    return role === Roles.Accounting;
}

export function isAccountingAdmin(role: string | null | undefined): boolean {
    return role === Roles.Owner || role === Roles.Administrator;
}

export function canAccessAccountingWorkspace(role: string | null | undefined): boolean {
    return isAccountingTeam(role) || isAccountingAdmin(role);
}

export function permissionsForAccounting(
    role: string | null | undefined,
    subRole: string | null | undefined
): AccountingPermission[] {
    if (isAccountingAdmin(role)) return ADMIN_PERMISSIONS;
    if (!isAccountingTeam(role)) return [];
    const sub = normalizeAccountingSubRole(subRole);
    return sub === AccountingSubRoles.Payments ? PAYMENTS_PERMISSIONS : DOCUMENTS_PERMISSIONS;
}

export function hasAccountingPermission(
    role: string | null | undefined,
    subRole: string | null | undefined,
    permission: AccountingPermission
): boolean {
    return permissionsForAccounting(role, subRole).includes(permission);
}

export function accountingTeamLabel(subRole: string | null | undefined): string {
    if (!isAccountingSubRole(subRole)) return "Accounting Team";
    return ACCOUNTING_SUB_ROLE_LABELS[subRole];
}

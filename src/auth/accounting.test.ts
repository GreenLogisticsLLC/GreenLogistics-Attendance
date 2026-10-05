import test from "node:test";
import assert from "node:assert/strict";
import {
    AccountingPermissions,
    AccountingSubRoles,
    canAccessAccountingWorkspace,
    hasAccountingPermission,
    isAccountingTeam,
    normalizeAccountingSubRole,
    permissionsForAccounting,
} from "./accounting.js";
import { canAccessModule, Roles } from "./roles.js";
import { AccountingService } from "../modules/accounting/services/accounting.service.js";
import { AccountingDocStatus } from "../modules/accounting/accounting.constants.js";

test("TEST 1: Accounting Documents can access Accounting workspace", () => {
    assert.equal(canAccessAccountingWorkspace(Roles.Accounting), true);
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Documents,
            AccountingPermissions.Access
        ),
        true
    );
    assert.equal(canAccessModule(Roles.Accounting, "accounting"), true);
});

test("TEST 2: Accounting Payments can access Accounting workspace", () => {
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Payments,
            AccountingPermissions.Access
        ),
        true
    );
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Payments,
            AccountingPermissions.CarrierPaymentsExecute
        ),
        true
    );
});

test("TEST 3: Broker cannot access Accounting workspace", () => {
    assert.equal(canAccessAccountingWorkspace(Roles.Broker), false);
    assert.equal(canAccessModule(Roles.Broker, "accounting"), false);
    assert.equal(
        hasAccountingPermission(Roles.Broker, null, AccountingPermissions.Access),
        false
    );
});

test("TEST 4: Operations (Manager/Team Lead) cannot access Accounting workspace", () => {
    assert.equal(canAccessAccountingWorkspace(Roles.Manager), false);
    assert.equal(canAccessAccountingWorkspace(Roles.TeamLead), false);
    assert.equal(canAccessModule(Roles.Manager, "accounting"), false);
    assert.equal(canAccessModule(Roles.TeamLead, "accounting"), false);
});

test("TEST 5: Accounting Documents cannot execute Carrier Payment", () => {
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Documents,
            AccountingPermissions.CarrierPaymentsExecute
        ),
        false
    );
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Documents,
            AccountingPermissions.CustomerPaymentsRecord
        ),
        false
    );
});

test("TEST 6: Accounting Payments cannot approve documents", () => {
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Payments,
            AccountingPermissions.DocumentsVerify
        ),
        false
    );
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Payments,
            AccountingPermissions.DocumentsReject
        ),
        false
    );
    assert.equal(
        hasAccountingPermission(
            Roles.Accounting,
            AccountingSubRoles.Payments,
            AccountingPermissions.FinancialsVerify
        ),
        false
    );
});

test("TEST 7: Carrier payment blocked before document verification", () => {
    assert.throws(
        () =>
            AccountingService.assertCarrierPaymentAllowed(
                {
                    accountingDocStatus: AccountingDocStatus.Pending,
                    accountingFinancialVerified: false,
                    accountingReadyForCarrierPayment: false,
                },
                Roles.Accounting
            ),
        (err: Error & { code?: string; status?: number }) =>
            err.code === "CARRIER_PAYMENT_BLOCKED" && err.status === 403
    );
    assert.throws(
        () =>
            AccountingService.assertCarrierPaymentAllowed(
                {
                    accountingDocStatus: AccountingDocStatus.Verified,
                    accountingFinancialVerified: true,
                    accountingReadyForCarrierPayment: false,
                },
                Roles.Accounting
            ),
        (err: Error & { code?: string }) => err.code === "CARRIER_PAYMENT_BLOCKED"
    );
});

test("TEST 8: After verification, Carrier Payment gate allows Accounting", () => {
    assert.doesNotThrow(() =>
        AccountingService.assertCarrierPaymentAllowed(
            {
                accountingDocStatus: AccountingDocStatus.Verified,
                accountingFinancialVerified: true,
                accountingReadyForCarrierPayment: true,
            },
            Roles.Accounting
        )
    );
});

test("TEST 9: Unauthorized permission check fails (403 semantics)", () => {
    assert.equal(
        hasAccountingPermission(
            Roles.Broker,
            AccountingSubRoles.Payments,
            AccountingPermissions.CarrierPaymentsExecute
        ),
        false
    );
    assert.equal(permissionsForAccounting(Roles.Dispatcher, null).length, 0);
});

test("TEST 10: Admin/Owner can access Accounting", () => {
    assert.equal(canAccessAccountingWorkspace(Roles.Owner), true);
    assert.equal(canAccessAccountingWorkspace(Roles.Administrator), true);
    assert.equal(
        hasAccountingPermission(Roles.Owner, null, AccountingPermissions.DocumentsVerify),
        true
    );
    assert.equal(
        hasAccountingPermission(
            Roles.Administrator,
            null,
            AccountingPermissions.CarrierPaymentsExecute
        ),
        true
    );
    // Admin override on workflow gate
    assert.doesNotThrow(() =>
        AccountingService.assertCarrierPaymentAllowed(
            {
                accountingDocStatus: AccountingDocStatus.Pending,
                accountingFinancialVerified: false,
                accountingReadyForCarrierPayment: false,
            },
            Roles.Owner
        )
    );
});

test("TEST 11/12: Team identity + sub-role normalize; leaving Accounting clears team", () => {
    assert.equal(isAccountingTeam(Roles.Accounting), true);
    assert.equal(isAccountingTeam(Roles.Broker), false);
    assert.equal(
        normalizeAccountingSubRole("ACCOUNTING_PAYMENTS"),
        AccountingSubRoles.Payments
    );
    assert.equal(
        normalizeAccountingSubRole("documents"),
        AccountingSubRoles.Documents
    );
    // Broker after role change has no accounting permissions
    assert.equal(
        permissionsForAccounting(Roles.Broker, AccountingSubRoles.Payments).length,
        0
    );
});

test("TEST 13: Existing Broker/Ops modules remain available; Accounting isolated", () => {
    assert.equal(canAccessModule(Roles.Broker, "broker"), true);
    assert.equal(canAccessModule(Roles.Manager, "crm"), true);
    assert.equal(canAccessModule(Roles.TeamLead, "shipments"), true);
    assert.equal(canAccessModule(Roles.Accounting, "broker"), false);
    assert.equal(canAccessModule(Roles.Accounting, "crm"), false);
    assert.equal(canAccessModule(Roles.Accounting, "loads"), false);
    assert.equal(canAccessModule(Roles.Accounting, "email"), false);
    assert.equal(canAccessModule(Roles.Accounting, "employees"), false);
    assert.equal(canAccessModule(Roles.Accounting, "ai"), false);
});

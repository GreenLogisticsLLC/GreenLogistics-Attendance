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
import { buildAccountingDocuments } from "../modules/accounting/accounting-documents.js";

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

test("accounting shipment documents open as PDF and include carrier uploads", () => {
    const rows = buildAccountingDocuments({
        shipmentLeadId: "ship-1",
        loadDocs: [
            {
                documentId: "ld-rc",
                docType: "RATE_CONFIRMATION",
                status: "READY",
                fileName: "rc.pdf",
                fileUrl: "/uploads/loads/ship-1/rc.pdf",
                mimeType: "application/pdf",
            },
            {
                documentId: "ld-bol",
                docType: "BOL",
                status: "READY",
                fileName: "bol.pdf",
                fileUrl: "/uploads/loads/ship-1/bol.pdf",
            },
            {
                documentId: "ld-sheet",
                docType: "DISPATCH_SHEET",
                status: "READY",
                fileName: "sheet.pdf",
                fileUrl: "/uploads/loads/ship-1/sheet.pdf",
            },
        ],
        carrierDocs: [
            {
                documentId: "cd-rc",
                carrierId: "car-1",
                documentType: "RATE_CONFIRMATION",
                status: "CURRENT",
                originalFilename: "signed-rc.pdf",
                mimeType: "application/pdf",
            },
            {
                documentId: "cd-mc",
                carrierId: "car-1",
                documentType: "MC_AUTHORITY",
                status: "CURRENT",
                originalFilename: "authority.pdf",
                mimeType: "application/octet-stream",
            },
            {
                documentId: "cd-noa",
                carrierId: "car-1",
                documentType: "NOA",
                status: "CURRENT",
                originalFilename: "noa.pdf",
                mimeType: "application/pdf",
            },
            {
                documentId: "cd-w9",
                carrierId: "car-1",
                documentType: "W9",
                status: "CURRENT",
                originalFilename: "w9.pdf",
                mimeType: "application/pdf",
            },
            {
                documentId: "cd-ins",
                carrierId: "car-1",
                documentType: "INSURANCE",
                status: "CURRENT",
                originalFilename: "coi.jpg",
                mimeType: "image/jpeg",
            },
            {
                documentId: "cd-ag",
                carrierId: "car-1",
                documentType: "BROKER_CARRIER_AGREEMENT",
                status: "CURRENT",
                originalFilename: "agreement.pdf",
                mimeType: "application/pdf",
            },
        ],
    });
    assert.deepEqual(
        rows.map((row) => row.label),
        [
            "Rate Confirmation",
            "BOL",
            "Broker–Carrier Agreement",
            "MC Authority",
            "NOA/VOID CHECK-OTHER",
            "W-9",
            "Insurance",
        ]
    );
    const rc = rows[0];
    assert.equal(rc.openUrl, "/api/loads/ship-1/documents/ld-rc/download?inline=1");
    assert.equal(rc.mimeType, "application/pdf");
    assert.equal(rc.openUrl?.includes("/uploads/"), false);
    const mc = rows.find((row) => row.docType === "MC_AUTHORITY");
    assert.equal(mc?.mimeType, "application/pdf");
    assert.equal(mc?.status, "Uploaded");
    assert.equal(mc?.openUrl, "/api/carriers/car-1/documents/cd-mc/download?inline=1");
    const ins = rows.find((row) => row.docType === "INSURANCE");
    assert.equal(ins?.mimeType, "image/jpeg");
    assert.equal(rows.some((row) => row.documentId === "cd-rc"), false);
    assert.equal(rows.some((row) => row.docType === "DISPATCH_SHEET"), false);
});

test("accounting ADD DOCUMENTS attachments keep separate labels", () => {
    const rows = buildAccountingDocuments({
        shipmentLeadId: "ship-2",
        loadDocs: [
            {
                documentId: "att-1",
                docType: "ATTACHMENT",
                status: "READY",
                fileName: "extra-scan-1.pdf",
                fileUrl: "/uploads/loads/ship-2/a1.pdf",
                mimeType: "application/pdf",
            },
            {
                documentId: "att-2",
                docType: "ATTACHMENT",
                status: "READY",
                fileName: "extra-scan-2.pdf",
                fileUrl: "/uploads/loads/ship-2/a2.pdf",
                mimeType: "application/pdf",
            },
        ],
        carrierDocs: [],
    });
    const attachments = rows.filter((row) => row.docType === "ATTACHMENT");
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0].label, "Attachment · extra-scan-1.pdf");
    assert.equal(attachments[1].label, "Attachment · extra-scan-2.pdf");
    assert.ok(attachments.every((row) => Boolean(row.openUrl)));
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

import assert from "node:assert/strict";
import test from "node:test";
import {
    AccountingPermissions,
    AccountingSubRoles,
    hasAccountingPermission,
} from "../../auth/accounting.js";
import { canTransition } from "../shipment/shipment.lifecycle.js";

test("Documents sub-role can send carrier invoice into AP (BillingSend)", () => {
    assert.equal(
        hasAccountingPermission(
            "Accounting",
            AccountingSubRoles.Documents,
            AccountingPermissions.BillingSend
        ),
        true
    );
    assert.equal(
        hasAccountingPermission(
            "Accounting",
            AccountingSubRoles.Documents,
            AccountingPermissions.CarrierPaymentsView
        ),
        true
    );
    assert.equal(
        hasAccountingPermission(
            "Accounting",
            AccountingSubRoles.Documents,
            AccountingPermissions.CarrierPaymentsExecute
        ),
        false
    );
});

test("POD_UPLOADED and CUSTOMER_INVOICE can move to CARRIER_PAYMENT", () => {
    assert.equal(canTransition("POD_UPLOADED", "CARRIER_PAYMENT"), true);
    assert.equal(canTransition("CUSTOMER_INVOICE", "CARRIER_PAYMENT"), true);
});

/** Accounting Documents review status on ShipmentLead. */
export const AccountingDocStatus = {
    Pending: "PENDING",
    NeedsCorrection: "NEEDS_CORRECTION",
    Verified: "VERIFIED",
    Rejected: "REJECTED",
} as const;

export type AccountingDocStatusValue =
    (typeof AccountingDocStatus)[keyof typeof AccountingDocStatus];

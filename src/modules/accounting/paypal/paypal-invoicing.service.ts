/**
 * PayPal Invoicing API v2 service for customer invoices.
 *
 * Not Checkout: invoice ids are PayPal Invoicing ids (INV2-…), never Checkout order
 * ids. Customers pay on the PayPal-hosted invoice page, so this service NEVER calls
 * the "record payment" API — payment is confirmed by verified invoice status
 * (webhook / GET sync) with an exact-cents amount match.
 *
 * Environment isolation: PAYPAL_INVOICING_MODE (default sandbox) picks the
 * environment for NEW invoices; every invoice keeps its environment permanently
 * and later operations always target that environment.
 */
import { randomUUID } from "crypto";
import type { Prisma, PayPalCustomerInvoice, PayPalInvoiceOperation } from "@prisma/client";
import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import {
    AccountingPermissions,
    hasAccountingPermission,
    type AccountingSubRole,
} from "../../../auth/accounting.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { customerPaymentQuote } from "../../shipment/customer-payment.js";
import {
    buildInvoicePricingBreakdown,
    createInvoicePricingSnapshot,
    loadInvoicePricingSettings,
    roundUsd,
} from "../invoice-pricing.js";
import {
    assertInvoicingEnvConfigured,
    type PayPalEnvironment,
} from "./paypal-env.js";
import {
    buildPayPalInvoicePayload,
    cancelInvoice,
    createDraftInvoice,
    deleteDraftInvoice,
    getInvoice,
    parsePayPalInvoice,
    remindInvoice,
    searchInvoices,
    sendInvoice,
    type PayPalInvoiceSummary,
} from "./paypal-invoicing-client.js";
import {
    amountsMatchUsd,
    decideInvoiceStatusTransition,
    invoicingActionRequestId,
    invoicingAttemptKey,
    invoicingCreateRequestId,
    isAmbiguousPayPalFailure,
    isReusableOpenPayPalInvoice,
    isTerminalPayPalInvoiceStatus,
    MAX_INVOICING_ATTEMPTS,
    PAYPAL_INVOICE_OPEN_STATUSES,
    payPalInvoiceNumberForAttempt,
    verifyInvoicePaidAmount,
} from "./paypal-invoicing-safety.js";
import { SHIPMENT_PAID_BLOCKING_STATUSES } from "./paypal-payment-safety.js";

type Actor = {
    userId: string;
    role: string;
    accountingSubRole?: AccountingSubRole | null;
};

const PAID_SHIPMENT_STATUSES = ["CUSTOMER_PAID", "CUSTOMER_AND_CARRIER_PAID"];

function forbid(message: string, code = "ACCOUNTING_FORBIDDEN") {
    return Object.assign(new Error(message), { status: 403, code });
}

function badRequest(message: string, code = "ACCOUNTING_INVALID") {
    return Object.assign(new Error(message), { status: 422, code });
}

function conflict(message: string, code: string) {
    return Object.assign(new Error(message), { status: 409, code });
}

function notFound(message: string) {
    return Object.assign(new Error(message), { status: 404, code: "NOT_FOUND" });
}

function assertCanManageInvoices(actor: Actor) {
    const ok = hasAccountingPermission(
        actor.role,
        actor.accountingSubRole,
        AccountingPermissions.BillingSend
    );
    if (!ok) {
        throw forbid("You cannot create or send PayPal invoices");
    }
}

function toCents(amount: number): number {
    return Math.round(Number(amount) * 100);
}

function normEnv(value: string | null | undefined): PayPalEnvironment {
    return String(value || "").toLowerCase() === "live" ? "live" : "sandbox";
}

function safeMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, 500);
}

function parseDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Line label must never read as a PayPal / payment-method surcharge. */
function safeFeeLabel(label: string | null | undefined): string {
    const trimmed = String(label || "").trim();
    return !trimmed || /paypal|surcharge/i.test(trimmed) ? "Handling fee" : trimmed.slice(0, 80);
}

export function buildInvoiceLineItems(input: {
    loadNumber?: string | null;
    subtotalUsd: number;
    feeAmountUsd: number;
    feeLabel?: string | null;
    totalUsd: number;
}) {
    const subtotal = roundUsd(input.subtotalUsd);
    const fee = roundUsd(input.feeAmountUsd);
    if (!(subtotal > 0)) {
        throw badRequest("Invoice subtotal must be greater than zero", "INVOICE_TOTAL_INVALID");
    }
    if (fee < 0) {
        throw badRequest("Invoice amounts cannot be negative", "INVOICE_AMOUNT_INVALID");
    }
    if (toCents(subtotal) + toCents(fee) !== toCents(input.totalUsd)) {
        throw badRequest(
            "Invoice line items do not add up to the invoice total",
            "INVOICE_TOTAL_MISMATCH"
        );
    }
    const items: Array<{ name: string; quantity: number; unitAmount: number }> = [
        {
            name: `Freight services${input.loadNumber ? ` - ${input.loadNumber}` : ""}`,
            quantity: 1,
            unitAmount: subtotal,
        },
    ];
    if (fee > 0) {
        items.push({ name: safeFeeLabel(input.feeLabel), quantity: 1, unitAmount: fee });
    }
    return items;
}

function mapRow(row: PayPalCustomerInvoice) {
    return {
        paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
        shipmentLeadId: row.shipmentLeadId,
        paypalInvoiceId: row.paypalInvoiceId,
        environment: normEnv(row.environment),
        greenOsInvoiceNumber: row.greenOsInvoiceNumber,
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        currency: row.currency,
        subtotalUsd: row.subtotalUsd,
        feeAmountUsd: row.feeAmountUsd,
        feeType: row.feeType,
        feeConfiguredValue: row.feeConfiguredValue,
        feeDescription: row.feeDescription,
        pricingVersion: row.pricingVersion,
        totalUsd: row.totalUsd,
        status: row.status,
        hostedInvoiceUrl: row.hostedInvoiceUrl,
        paymentUrl: row.hostedInvoiceUrl,
        dueDate: row.dueDate,
        sentAt: row.sentAt,
        paidAt: row.paidAt,
        cancelledAt: row.cancelledAt,
        lastSyncedAt: row.lastSyncedAt,
        paymentTransactionId: row.paymentTransactionId,
        attemptCount: row.attemptCount,
        lastError: row.lastError,
        needsAccountingReview: row.needsAccountingReview,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        invoicingMode: config.paypal.invoicingMode,
    };
}

async function writeAudit(input: {
    actor?: Actor | null;
    auditUserId?: string | null;
    action: string;
    shipmentLeadId: string;
    newValue?: unknown;
}) {
    const userId = input.actor?.userId || input.auditUserId;
    if (!userId || userId === "paypal-webhook") return;
    try {
        await prisma.auditLog.create({
            data: {
                userId,
                module: "ACCOUNTING",
                action: input.action,
                entityName: "PayPalCustomerInvoice",
                entityId: input.shipmentLeadId,
                newValue: input.newValue != null ? JSON.stringify(input.newValue) : null,
            },
        });
    } catch {
        /* ignore audit failures */
    }
}

type ShipmentRow = NonNullable<Awaited<ReturnType<typeof prisma.shipmentLead.findUnique>>>;

type ApplyOutcome = { row: PayPalCustomerInvoice; result: string };

export class PayPalInvoicingService {
    async getLatestForShipment(shipmentLeadId: string) {
        const row = await prisma.payPalCustomerInvoice.findFirst({
            where: { shipmentLeadId },
            orderBy: { createdAt: "desc" },
        });
        return row ? mapRow(row) : null;
    }

    private async loadShipment(shipmentLeadId: string): Promise<ShipmentRow> {
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        return s;
    }

    private async resolveInvoice(idOrShipmentId: string): Promise<PayPalCustomerInvoice> {
        const byId = await prisma.payPalCustomerInvoice.findUnique({
            where: { paypalCustomerInvoiceId: idOrShipmentId },
        });
        if (byId) return byId;
        const latest = await prisma.payPalCustomerInvoice.findFirst({
            where: { shipmentLeadId: idOrShipmentId },
            orderBy: { createdAt: "desc" },
        });
        if (!latest) throw notFound("No PayPal invoice on this load yet");
        return latest;
    }

    private quoteFor(
        s: ShipmentRow,
        pricing: Awaited<ReturnType<typeof loadInvoicePricingSettings>>
    ) {
        return customerPaymentQuote({
            customerRate: s.customerRate,
            accessorialCharges: s.accessorialCharges,
            method: s.customerPaymentMethod,
            waiveFee: s.waiveCustomerPaymentFee,
            pricing,
            pricingSnapshot: s.invoicePricingSnapshotJson,
        });
    }

    private invoiceNumberFor(s: ShipmentRow): string {
        return (
            String(s.invoiceNumber || "").trim() ||
            (s.loadNumber
                ? String(s.loadNumber).replace(/^GL/i, "INV-")
                : `INV-${s.shipmentLeadId.slice(0, 8).toUpperCase()}`)
        );
    }

    /** Blocks that must hold before any PayPal invoice is created. */
    private async assertNotAlreadyPaid(s: ShipmentRow) {
        if (s.customerPaidAt) {
            throw badRequest("Customer is already marked paid on this load", "CUSTOMER_ALREADY_PAID");
        }
        const checkoutPaid = await prisma.payPalCustomerOrder.findFirst({
            where: {
                shipmentLeadId: s.shipmentLeadId,
                status: "COMPLETED",
                paidAt: { not: null },
                refundedAt: null,
                reversedAt: null,
            },
        });
        if (checkoutPaid) {
            throw badRequest(
                "A PayPal Checkout payment was already completed for this load",
                "CHECKOUT_ALREADY_PAID"
            );
        }
    }

    /**
     * Read-only quote — freight subtotal plus the optional handling fee. The fee is
     * method-neutral and never labelled as a PayPal surcharge.
     */
    async preview(actor: Actor, shipmentLeadId: string) {
        assertCanManageInvoices(actor);
        const s = await this.loadShipment(shipmentLeadId);
        const pricing = await loadInvoicePricingSettings();
        const quote = this.quoteFor(s, pricing);
        const environment = config.paypal.invoicingMode;
        const invoicingEnv = config.paypal.invoicingActive;
        const blockers: string[] = [];
        if (s.customerPaidAt) blockers.push("Customer is already marked paid on this load");
        if (quote.total == null || quote.total <= 0) {
            blockers.push("Customer rate is missing or zero");
        }
        const email = String(s.customerEmail || "").trim();
        if (!email.includes("@")) blockers.push("Customer email is missing");
        if (!invoicingEnv.configured) {
            blockers.push(`PayPal Invoicing (${environment}) credentials are not configured`);
        }
        const latest = await this.getLatestForShipment(shipmentLeadId);
        const lineItems =
            quote.total != null && quote.subtotal != null && quote.total > 0 && quote.subtotal > 0
                ? buildInvoiceLineItems({
                      loadNumber: s.loadNumber,
                      subtotalUsd: quote.subtotal,
                      feeAmountUsd: quote.fee,
                      feeLabel: quote.lineItemLabel,
                      totalUsd: quote.total,
                  })
                : [];
        return {
            shipmentLeadId,
            environment,
            configured: invoicingEnv.configured,
            webhookConfigured: invoicingEnv.invoicingWebhookConfigured,
            currency: "USD" as const,
            invoiceNumber: this.invoiceNumberFor(s),
            customerName: s.customerName,
            customerEmail: s.customerEmail,
            subtotalUsd: quote.subtotal,
            feeAmountUsd: quote.fee,
            feeType: quote.feeType,
            feeConfiguredValue: quote.feeConfiguredValue,
            feeDescription: quote.fee > 0 ? safeFeeLabel(quote.lineItemLabel) : null,
            pricingVersion: quote.pricingVersion,
            totalUsd: quote.total,
            pricingLocked: Boolean(s.invoicePricingSnapshotJson),
            lineItems,
            existingInvoice: latest,
            blockers,
            canCreate: blockers.length === 0,
            note:
                "Any additional fee is a method-neutral handling fee, never a PayPal surcharge. " +
                "PayPal's own processing fees are separate and not added here.",
        };
    }

    /** Lock the GreenOS pricing snapshot (same rule as accounting createInvoice) and invoice dates. */
    private async lockPricingAndDates(s: ShipmentRow): Promise<ShipmentRow> {
        const now = new Date();
        if (!s.invoicePricingSnapshotJson) {
            const settings = await loadInvoicePricingSettings();
            const breakdown = buildInvoicePricingBreakdown({
                customerRate: s.customerRate,
                accessorialCharges: s.accessorialCharges,
                waiveFee: s.waiveCustomerPaymentFee,
                settings,
            });
            if (breakdown.totalUsd == null || !(breakdown.totalUsd > 0)) {
                throw badRequest(
                    "Customer payment amount is missing. Save Customer Rate first.",
                    "INVOICE_TOTAL_INVALID"
                );
            }
            const snapshot = createInvoicePricingSnapshot({ settings, breakdown });
            const invoiceDate = s.invoiceDate || now;
            // Concurrent callers: only the first writer locks; losers re-read.
            await prisma.shipmentLead.updateMany({
                where: { shipmentLeadId: s.shipmentLeadId, invoicePricingSnapshotJson: null },
                data: {
                    invoiceNumber: this.invoiceNumberFor(s),
                    invoiceDate,
                    invoiceDueDate: s.invoiceDueDate || addDays(invoiceDate, 30),
                    paymentStatus: s.paymentStatus || "INVOICED",
                    invoicePricingVersion: snapshot.version,
                    invoiceFeeType: snapshot.feeType,
                    invoiceFeeConfiguredValue: snapshot.configuredValue,
                    invoiceFeeAmountUsd: snapshot.feeAmountUsd,
                    invoiceSubtotalUsd: snapshot.subtotalUsd,
                    invoiceTotalUsd: snapshot.totalUsd,
                    invoicePricingSnapshotJson: JSON.stringify(snapshot),
                },
            });
        }
        // Dates must be stable across retries (same PayPal-Request-Id ⇒ same body).
        await prisma.shipmentLead.updateMany({
            where: { shipmentLeadId: s.shipmentLeadId, invoiceDate: null },
            data: { invoiceDate: now },
        });
        const withDate = await this.loadShipment(s.shipmentLeadId);
        if (!withDate.invoiceDueDate) {
            await prisma.shipmentLead.updateMany({
                where: { shipmentLeadId: s.shipmentLeadId, invoiceDueDate: null },
                data: { invoiceDueDate: addDays(withDate.invoiceDate || now, 30) },
            });
        }
        if (!withDate.invoiceNumber) {
            await prisma.shipmentLead.updateMany({
                where: { shipmentLeadId: s.shipmentLeadId, invoiceNumber: null },
                data: { invoiceNumber: this.invoiceNumberFor(withDate) },
            });
        }
        return this.loadShipment(s.shipmentLeadId);
    }

    private async ensureOperation(input: {
        environment: PayPalEnvironment;
        operationType: "CREATE" | "SEND" | "CANCEL" | "REMIND" | "SYNC" | "UPDATE";
        logicalOperationId: string;
        requestId: string;
        paypalCustomerInvoiceId?: string | null;
        paypalInvoiceId?: string | null;
    }): Promise<PayPalInvoiceOperation> {
        const existing = await prisma.payPalInvoiceOperation.findUnique({
            where: { requestId: input.requestId },
        });
        if (existing) return existing;
        try {
            return await prisma.payPalInvoiceOperation.create({
                data: {
                    environment: input.environment,
                    operationType: input.operationType,
                    logicalOperationId: input.logicalOperationId,
                    requestId: input.requestId,
                    paypalCustomerInvoiceId: input.paypalCustomerInvoiceId || null,
                    paypalInvoiceId: input.paypalInvoiceId || null,
                    status: "PENDING",
                },
            });
        } catch (err) {
            const raced = await prisma.payPalInvoiceOperation.findUnique({
                where: { requestId: input.requestId },
            });
            if (raced) return raced;
            throw err;
        }
    }

    private async finishOperation(
        requestId: string,
        data: {
            status: "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW" | "PENDING";
            lastError?: string | null;
            paypalInvoiceId?: string | null;
            paypalCustomerInvoiceId?: string | null;
        }
    ) {
        await prisma.payPalInvoiceOperation.update({
            where: { requestId },
            data: {
                status: data.status,
                lastError: data.lastError ?? null,
                ...(data.paypalInvoiceId ? { paypalInvoiceId: data.paypalInvoiceId } : {}),
                ...(data.paypalCustomerInvoiceId
                    ? { paypalCustomerInvoiceId: data.paypalCustomerInvoiceId }
                    : {}),
                completedAt: data.status === "PENDING" ? null : new Date(),
            },
        });
    }

    /**
     * Create (or reuse) a PayPal DRAFT invoice. One logical create keeps one
     * PayPal-Request-Id forever: a timeout never mints a new key.
     */
    async createDraft(
        actor: Actor,
        shipmentLeadId: string,
        body: { confirmPricing?: boolean } = {}
    ) {
        assertCanManageInvoices(actor);
        if (!body?.confirmPricing) {
            throw badRequest(
                "Confirm subtotal, additional fee, and final total before creating the PayPal invoice",
                "INVOICE_PRICING_CONFIRM_REQUIRED"
            );
        }
        const environment = config.paypal.invoicingMode;
        assertInvoicingEnvConfigured(environment);

        let s = await this.loadShipment(shipmentLeadId);
        await this.assertNotAlreadyPaid(s);
        const email = String(s.customerEmail || "").trim();
        if (!email.includes("@")) {
            throw badRequest(
                "Customer email is missing on this load. Add the customer email, then create the invoice again.",
                "CUSTOMER_EMAIL_REQUIRED"
            );
        }

        s = await this.lockPricingAndDates(s);
        const pricing = await loadInvoicePricingSettings();
        const quote = this.quoteFor(s, pricing);
        if (quote.total == null || quote.total <= 0 || quote.subtotal == null) {
            throw badRequest("Invoice total is invalid", "INVOICE_TOTAL_INVALID");
        }
        const totalUsd = quote.total;
        const invoiceNumber = this.invoiceNumberFor(s);
        const lineItems = buildInvoiceLineItems({
            loadNumber: s.loadNumber,
            subtotalUsd: quote.subtotal,
            feeAmountUsd: quote.fee,
            feeLabel: quote.lineItemLabel,
            totalUsd,
        });

        // Same env + amount ⇒ reuse; any other open invoice in this env blocks (no double billing).
        const open = await prisma.payPalCustomerInvoice.findMany({
            where: {
                shipmentLeadId,
                environment,
                status: { in: [...PAYPAL_INVOICE_OPEN_STATUSES] },
            },
            orderBy: { createdAt: "desc" },
        });
        const reusable = open.find((row) =>
            isReusableOpenPayPalInvoice(row, {
                environment,
                totalUsd,
                currency: "USD",
                invoiceNumber,
            })
        );
        if (reusable) return { ...mapRow(reusable), reused: true };
        if (open.length) {
            throw conflict(
                "An open PayPal invoice already exists for this load with different details. Cancel it before creating another.",
                "PAYPAL_INVOICE_OPEN_EXISTS"
            );
        }

        const invoiceDate = s.invoiceDate || new Date();
        const dueDate =
            s.invoiceDueDate && s.invoiceDueDate >= invoiceDate ? s.invoiceDueDate : invoiceDate;
        const snapshotJson = s.invoicePricingSnapshotJson;

        for (let attempt = 0; attempt < MAX_INVOICING_ATTEMPTS; attempt += 1) {
            const idempotencyKey = invoicingAttemptKey(
                shipmentLeadId,
                toCents(totalUsd),
                invoiceNumber,
                environment,
                attempt
            );
            const existing = await prisma.payPalCustomerInvoice.findUnique({
                where: { idempotencyKey },
            });
            if (existing) {
                if (
                    isReusableOpenPayPalInvoice(existing, {
                        environment,
                        totalUsd,
                        currency: "USD",
                        invoiceNumber,
                    })
                ) {
                    return { ...mapRow(existing), reused: true };
                }
                continue;
            }

            const requestId = invoicingCreateRequestId(idempotencyKey);
            const op = await this.ensureOperation({
                environment,
                operationType: "CREATE",
                logicalOperationId: idempotencyKey,
                requestId,
            });
            // A definitively rejected create closed this slot; a timeout never does.
            if (op.status === "FAILED") continue;
            if (op.status === "NEEDS_REVIEW") {
                throw conflict(
                    "A previous PayPal invoice create needs Accounting review before retrying.",
                    "PAYPAL_INVOICE_NEEDS_REVIEW"
                );
            }

            const payPalNumber = payPalInvoiceNumberForAttempt(invoiceNumber, attempt);
            const payload = buildPayPalInvoicePayload({
                invoiceNumber: payPalNumber,
                invoiceDate,
                dueDate,
                currency: "USD",
                customerName: s.customerName,
                customerEmail: email,
                items: lineItems,
                reference: s.loadNumber || undefined,
                note: `Load ${s.loadNumber || shipmentLeadId.slice(0, 8)} - Green Logistics LLC`,
            });
            return this.executeCreate({
                actor,
                s,
                op,
                idempotencyKey,
                requestId,
                attempt,
                environment,
                payPalNumber,
                payload,
                quote,
                totalUsd,
                invoiceNumber,
                snapshotJson,
                dueDate,
                email,
            });
        }
        throw badRequest(
            "Too many closed PayPal invoice attempts for this load/amount. Contact Accounting.",
            "PAYPAL_INVOICE_RETRY_CHAIN_EXHAUSTED"
        );
    }

    private async executeCreate(input: {
        actor: Actor;
        s: ShipmentRow;
        op: PayPalInvoiceOperation;
        idempotencyKey: string;
        requestId: string;
        attempt: number;
        environment: PayPalEnvironment;
        payPalNumber: string;
        payload: ReturnType<typeof buildPayPalInvoicePayload>;
        quote: ReturnType<PayPalInvoicingService["quoteFor"]>;
        totalUsd: number;
        invoiceNumber: string;
        snapshotJson: string | null;
        dueDate: Date;
        email: string;
    }) {
        const { op, requestId, environment, s } = input;
        let paypalInvoiceId: string | null = op.paypalInvoiceId || null;
        let createRaw: unknown = null;
        const priorAttempts = op.attemptCount;

        if (!paypalInvoiceId) {
            await prisma.payPalInvoiceOperation.update({
                where: { requestId },
                data: { attemptCount: { increment: 1 } },
            });
            // A retry after an unconfirmed attempt: look for the invoice before re-posting.
            if (priorAttempts > 0) {
                paypalInvoiceId = await this.findRemoteByNumber(
                    environment,
                    input.payPalNumber,
                    input.totalUsd
                );
            }
        }

        if (!paypalInvoiceId) {
            try {
                const created = await createDraftInvoice({
                    environment,
                    idempotencyKey: requestId,
                    body: input.payload,
                });
                paypalInvoiceId = created.id;
                createRaw = created.raw;
            } catch (err) {
                const ambiguous = isAmbiguousPayPalFailure(err);
                await this.finishOperation(requestId, {
                    status: ambiguous ? "PENDING" : "FAILED",
                    lastError: safeMessage(err),
                });
                if (ambiguous) {
                    throw Object.assign(
                        new Error(
                            "PayPal did not confirm the invoice (timeout or unavailable). " +
                                "Retry will reuse the same PayPal-Request-Id — no duplicate invoice will be created."
                        ),
                        { status: 504, code: "PAYPAL_INVOICE_CREATE_UNCONFIRMED" }
                    );
                }
                throw err;
            }
            await prisma.payPalInvoiceOperation.update({
                where: { requestId },
                data: { paypalInvoiceId },
            });
        }

        let remote;
        try {
            remote = await getInvoice(paypalInvoiceId, environment);
        } catch (err) {
            await this.finishOperation(requestId, {
                status: "PENDING",
                lastError: safeMessage(err),
                paypalInvoiceId,
            });
            throw Object.assign(
                new Error(
                    "PayPal invoice was created but could not be read back. Retry will reconcile it without creating a duplicate."
                ),
                { status: 504, code: "PAYPAL_INVOICE_READBACK_FAILED" }
            );
        }
        const remoteTotal = remote.summary.totalValue;
        if (
            remote.summary.currency !== "USD" ||
            remoteTotal == null ||
            !amountsMatchUsd(Number(remoteTotal), input.totalUsd)
        ) {
            await this.finishOperation(requestId, {
                status: "NEEDS_REVIEW",
                lastError: "PayPal invoice total does not match the GreenOS invoice total",
                paypalInvoiceId,
            });
            throw conflict(
                "PayPal invoice total does not match the GreenOS total. Accounting review required.",
                "PAYPAL_INVOICE_TOTAL_MISMATCH"
            );
        }

        let row: PayPalCustomerInvoice;
        try {
            row = await prisma.payPalCustomerInvoice.create({
                data: {
                    shipmentLeadId: s.shipmentLeadId,
                    environment,
                    greenOsInvoiceNumber: input.invoiceNumber,
                    paypalInvoiceId,
                    customerEmail: input.email,
                    customerName: s.customerName,
                    currency: "USD",
                    subtotalUsd: input.quote.subtotal ?? 0,
                    feeAmountUsd: input.quote.fee,
                    feeType: input.quote.feeType,
                    feeConfiguredValue: input.quote.feeConfiguredValue,
                    feeDescription: input.quote.fee > 0 ? safeFeeLabel(input.quote.lineItemLabel) : null,
                    pricingVersion: input.quote.pricingVersion,
                    pricingSnapshotJson: input.snapshotJson,
                    totalUsd: input.totalUsd,
                    status: remote.summary.status || "DRAFT",
                    hostedInvoiceUrl: remote.summary.hostedInvoiceUrl,
                    dueDate: input.dueDate,
                    lastSyncedAt: new Date(),
                    idempotencyKey: input.idempotencyKey,
                    createRequestId: requestId,
                    attemptCount: priorAttempts + 1,
                    createdByUserId: input.actor.userId,
                    rawCreateJson: createRaw ? JSON.stringify(createRaw) : null,
                    rawLatestJson: JSON.stringify(remote.raw),
                },
            });
        } catch (err) {
            const raced =
                (await prisma.payPalCustomerInvoice.findUnique({
                    where: { idempotencyKey: input.idempotencyKey },
                })) ||
                (await prisma.payPalCustomerInvoice.findUnique({ where: { paypalInvoiceId } }));
            if (!raced) throw err;
            await this.finishOperation(requestId, {
                status: "SUCCEEDED",
                paypalInvoiceId,
                paypalCustomerInvoiceId: raced.paypalCustomerInvoiceId,
            });
            return { ...mapRow(raced), reused: true };
        }

        await this.finishOperation(requestId, {
            status: "SUCCEEDED",
            paypalInvoiceId,
            paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
        });
        await domainEventEngine
            .emit({
                shipmentLeadId: s.shipmentLeadId,
                eventType: "PAYPAL_INVOICE_DRAFT_CREATED",
                title: "PayPal invoice draft created",
                message: `PayPal invoice ${paypalInvoiceId} for $${input.totalUsd.toFixed(2)}`,
                actorUserId: input.actor.userId,
                payload: {
                    paypalInvoiceId,
                    environment,
                    totalUsd: input.totalUsd,
                    feeAmountUsd: input.quote.fee,
                    attemptIdempotencyKey: input.idempotencyKey,
                },
            })
            .catch(() => null);
        await writeAudit({
            actor: input.actor,
            action: "PAYPAL_INVOICE_DRAFT_CREATED",
            shipmentLeadId: s.shipmentLeadId,
            newValue: {
                paypalInvoiceId,
                environment,
                totalUsd: input.totalUsd,
                feeAmountUsd: input.quote.fee,
                idempotencyKey: input.idempotencyKey,
            },
        });
        return { ...mapRow(row), reused: false };
    }

    /** Search PayPal for an invoice we may have created before a timeout. Never throws. */
    private async findRemoteByNumber(
        environment: PayPalEnvironment,
        payPalNumber: string,
        totalUsd: number
    ): Promise<string | null> {
        try {
            const found = await searchInvoices({ invoice_number: payPalNumber }, environment);
            const match = found.items.find(
                (item) =>
                    item.id &&
                    item.invoiceNumber === payPalNumber &&
                    item.status !== "CANCELLED" &&
                    item.totalValue != null &&
                    amountsMatchUsd(Number(item.totalValue), totalUsd)
            );
            return match?.id || null;
        } catch {
            return null;
        }
    }

    async send(actor: Actor, idOrShipmentId: string) {
        assertCanManageInvoices(actor);
        const row = await this.resolveInvoice(idOrShipmentId);
        const environment = normEnv(row.environment);
        assertInvoicingEnvConfigured(environment);
        if (isTerminalPayPalInvoiceStatus(row.status)) {
            throw badRequest(
                `A ${row.status} PayPal invoice cannot be sent`,
                "PAYPAL_INVOICE_NOT_SENDABLE"
            );
        }
        if (String(row.status).toUpperCase() !== "DRAFT") {
            return { ...mapRow(row), alreadySent: true };
        }
        const to = String(row.customerEmail || "").trim();
        if (!to.includes("@")) {
            throw badRequest("Customer email is missing on this PayPal invoice", "CUSTOMER_EMAIL_REQUIRED");
        }

        const requestId = invoicingActionRequestId("send", row.paypalInvoiceId);
        await this.ensureOperation({
            environment,
            operationType: "SEND",
            logicalOperationId: `${row.paypalInvoiceId}:send`,
            requestId,
            paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
            paypalInvoiceId: row.paypalInvoiceId,
        });
        await prisma.payPalInvoiceOperation.update({
            where: { requestId },
            data: { attemptCount: { increment: 1 } },
        });

        let hostedUrl: string | null = null;
        try {
            const sent = await sendInvoice(row.paypalInvoiceId, environment, requestId, {
                send_to_recipient: true,
                send_to_invoicer: false,
            });
            hostedUrl = sent.hostedInvoiceUrl;
        } catch (err) {
            // Another worker (or a timed-out earlier call) may already have sent it.
            const remote = await getInvoice(row.paypalInvoiceId, environment).catch(() => null);
            if (!remote || remote.summary.status === "DRAFT") {
                await this.finishOperation(requestId, {
                    status: isAmbiguousPayPalFailure(err) ? "PENDING" : "FAILED",
                    lastError: safeMessage(err),
                });
                throw err;
            }
        }

        const remote = await getInvoice(row.paypalInvoiceId, environment);
        const applied = await this.applyRemoteInvoice(row, remote.summary, remote.raw, {
            actor,
            source: "send",
        });
        const sentAt = applied.row.sentAt || new Date();
        const updated = await prisma.payPalCustomerInvoice.update({
            where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
            data: {
                sentAt,
                hostedInvoiceUrl: hostedUrl || remote.summary.hostedInvoiceUrl || applied.row.hostedInvoiceUrl,
            },
        });
        await this.finishOperation(requestId, {
            status: "SUCCEEDED",
            paypalInvoiceId: row.paypalInvoiceId,
        });

        const s = await this.loadShipment(row.shipmentLeadId);
        const paymentStatus = String(s.paymentStatus || "").toUpperCase();
        const blocked = [...PAID_SHIPMENT_STATUSES, ...SHIPMENT_PAID_BLOCKING_STATUSES].includes(
            paymentStatus
        );
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: row.shipmentLeadId },
            data: {
                invoiceNumber: s.invoiceNumber || row.greenOsInvoiceNumber,
                accountingReadyForBilling: true,
                ...(blocked ? {} : { paymentStatus: "INVOICE_SENT" }),
            },
        });
        await domainEventEngine
            .emit({
                shipmentLeadId: row.shipmentLeadId,
                eventType: "CUSTOMER_INVOICE_SENT",
                title: "Customer invoice sent (PayPal)",
                message: `PayPal invoice ${row.paypalInvoiceId} sent to ${to}`,
                actorUserId: actor.userId,
                payload: {
                    paypalInvoiceId: row.paypalInvoiceId,
                    environment,
                    totalUsd: row.totalUsd,
                    via: "paypal_invoice",
                },
            })
            .catch(() => null);
        await writeAudit({
            actor,
            action: "PAYPAL_INVOICE_SENT",
            shipmentLeadId: row.shipmentLeadId,
            newValue: { paypalInvoiceId: row.paypalInvoiceId, environment, to },
        });
        return { ...mapRow(updated), alreadySent: false };
    }

    async cancel(actor: Actor, idOrShipmentId: string, note?: string | null) {
        assertCanManageInvoices(actor);
        const row = await this.resolveInvoice(idOrShipmentId);
        const environment = normEnv(row.environment);
        assertInvoicingEnvConfigured(environment);
        const status = String(row.status).toUpperCase();
        if (status === "CANCELLED") return mapRow(row);
        if (isTerminalPayPalInvoiceStatus(status) || row.paidAt) {
            throw badRequest(
                `A ${status} PayPal invoice cannot be cancelled`,
                "PAYPAL_INVOICE_NOT_CANCELLABLE"
            );
        }

        const requestId = invoicingActionRequestId("cancel", row.paypalInvoiceId);
        await this.ensureOperation({
            environment,
            operationType: "CANCEL",
            logicalOperationId: `${row.paypalInvoiceId}:cancel`,
            requestId,
            paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
            paypalInvoiceId: row.paypalInvoiceId,
        });
        await prisma.payPalInvoiceOperation.update({
            where: { requestId },
            data: { attemptCount: { increment: 1 } },
        });

        const cleanNote = String(note || "").trim().slice(0, 4000);
        try {
            if (status === "DRAFT") {
                await deleteDraftInvoice(row.paypalInvoiceId, environment);
            } else {
                await cancelInvoice(
                    row.paypalInvoiceId,
                    environment,
                    cleanNote ? { note: cleanNote } : undefined,
                    requestId
                );
            }
        } catch (err) {
            const remote = await getInvoice(row.paypalInvoiceId, environment).catch((e) => e);
            const alreadyGone =
                (remote as { paypalStatus?: number })?.paypalStatus === 404 && status === "DRAFT";
            const alreadyCancelled =
                remote && "summary" in remote && remote.summary.status === "CANCELLED";
            if (!alreadyGone && !alreadyCancelled) {
                await this.finishOperation(requestId, {
                    status: isAmbiguousPayPalFailure(err) ? "PENDING" : "FAILED",
                    lastError: safeMessage(err),
                });
                throw err;
            }
        }

        const now = new Date();
        const touched = await prisma.payPalCustomerInvoice.updateMany({
            where: {
                paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
                paidAt: null,
                status: { notIn: ["PAID", "MARKED_AS_PAID", "REFUNDED"] },
            },
            data: { status: "CANCELLED", cancelledAt: now, lastSyncedAt: now, lastError: null },
        });
        await this.finishOperation(requestId, { status: "SUCCEEDED" });
        const fresh = await prisma.payPalCustomerInvoice.findUnique({
            where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
        });
        if (!fresh) throw notFound("PayPal invoice not found");
        if (touched.count === 1) {
            await domainEventEngine
                .emit({
                    shipmentLeadId: row.shipmentLeadId,
                    eventType: "PAYPAL_INVOICE_CANCELLED",
                    title: "PayPal invoice cancelled",
                    message: `PayPal invoice ${row.paypalInvoiceId} cancelled`,
                    actorUserId: actor.userId,
                    payload: { paypalInvoiceId: row.paypalInvoiceId, environment },
                })
                .catch(() => null);
            await writeAudit({
                actor,
                action: "PAYPAL_INVOICE_CANCELLED",
                shipmentLeadId: row.shipmentLeadId,
                newValue: { paypalInvoiceId: row.paypalInvoiceId, environment, note: cleanNote || null },
            });
        }
        return mapRow(fresh);
    }

    async remind(actor: Actor, idOrShipmentId: string) {
        assertCanManageInvoices(actor);
        const row = await this.resolveInvoice(idOrShipmentId);
        const environment = normEnv(row.environment);
        assertInvoicingEnvConfigured(environment);
        const status = String(row.status).toUpperCase();
        if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(status)) {
            throw badRequest(
                `Reminders can only be sent for sent, unpaid invoices (status ${status})`,
                "PAYPAL_INVOICE_NOT_REMINDABLE"
            );
        }
        // Reminders are repeatable by design, so each call is its own logical operation.
        const requestId = randomUUID().replace(/-/g, "");
        await this.ensureOperation({
            environment,
            operationType: "REMIND",
            logicalOperationId: `${row.paypalInvoiceId}:remind:${requestId}`,
            requestId,
            paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
            paypalInvoiceId: row.paypalInvoiceId,
        });
        try {
            await remindInvoice(row.paypalInvoiceId, environment, undefined, requestId);
        } catch (err) {
            await this.finishOperation(requestId, { status: "FAILED", lastError: safeMessage(err) });
            throw err;
        }
        await this.finishOperation(requestId, { status: "SUCCEEDED" });
        await writeAudit({
            actor,
            action: "PAYPAL_INVOICE_REMINDER_SENT",
            shipmentLeadId: row.shipmentLeadId,
            newValue: { paypalInvoiceId: row.paypalInvoiceId, environment },
        });
        return mapRow(row);
    }

    /** GET the invoice from PayPal and reconcile local state (including payment). */
    async sync(actor: Actor, shipmentLeadId: string) {
        assertCanManageInvoices(actor);
        const row = await this.resolveInvoice(shipmentLeadId);
        const environment = normEnv(row.environment);
        assertInvoicingEnvConfigured(environment);
        let remote;
        try {
            remote = await getInvoice(row.paypalInvoiceId, environment);
        } catch (err) {
            if ((err as { paypalStatus?: number })?.paypalStatus === 404) {
                const flagged = await prisma.payPalCustomerInvoice.update({
                    where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
                    data: {
                        needsAccountingReview: true,
                        lastError: "Invoice not found in PayPal (deleted outside GreenOS?)",
                        lastSyncedAt: new Date(),
                    },
                });
                return mapRow(flagged);
            }
            throw err;
        }
        const applied = await this.applyRemoteInvoice(row, remote.summary, remote.raw, {
            actor,
            source: "sync",
        });
        return mapRow(applied.row);
    }

    /**
     * Verified PayPal Invoicing webhook (signature already checked by the dispatcher).
     * Only INVOICING.* events; Checkout events never reach this method.
     */
    async handleInvoicingWebhookEvent(input: {
        environment: PayPalEnvironment;
        eventType: string;
        resource: Record<string, unknown>;
        eventId: string;
        rawBody?: string;
    }): Promise<{
        result: string;
        paypalInvoiceId: string | null;
        shipmentLeadId: string | null;
    }> {
        const resource = input.resource || {};
        const inner =
            resource.invoice && typeof resource.invoice === "object"
                ? (resource.invoice as Record<string, unknown>)
                : resource;
        const paypalInvoiceId = String(inner.id || resource.id || "").trim() || null;
        if (!paypalInvoiceId) {
            throw badRequest("Invoicing webhook missing invoice id", "PAYPAL_INVOICE_ID_MISSING");
        }
        const row = await prisma.payPalCustomerInvoice.findUnique({ where: { paypalInvoiceId } });
        if (!row) {
            return { result: "ignored_unknown_invoice", paypalInvoiceId, shipmentLeadId: null };
        }
        if (normEnv(row.environment) !== input.environment) {
            return {
                result: "ignored_environment_mismatch",
                paypalInvoiceId,
                shipmentLeadId: row.shipmentLeadId,
            };
        }

        const eventStatusHint: Record<string, string> = {
            "INVOICING.INVOICE.PAID": "PAID",
            "INVOICING.INVOICE.CANCELLED": "CANCELLED",
            "INVOICING.INVOICE.REFUNDED": "REFUNDED",
            "INVOICING.INVOICE.SCHEDULED": "SCHEDULED",
        };
        const handled = new Set([
            ...Object.keys(eventStatusHint),
            "INVOICING.INVOICE.CREATED",
            "INVOICING.INVOICE.UPDATED",
        ]);
        if (!handled.has(input.eventType)) {
            return { result: "ignored_event_type", paypalInvoiceId, shipmentLeadId: row.shipmentLeadId };
        }

        let summary: PayPalInvoiceSummary = parsePayPalInvoice({ ...inner, id: paypalInvoiceId });
        let raw: unknown = inner;
        if (!summary.status && eventStatusHint[input.eventType]) {
            summary = { ...summary, status: eventStatusHint[input.eventType] };
        }
        if (!summary.status) {
            return { result: "ignored_no_status", paypalInvoiceId, shipmentLeadId: row.shipmentLeadId };
        }
        // Payment proof needs amounts; fall back to GET when the payload carries none.
        if (summary.status === "PAID" && summary.totalValue == null && summary.paidValue == null) {
            const remote = await getInvoice(paypalInvoiceId, input.environment);
            summary = remote.summary;
            raw = remote.raw;
        }

        const applied = await this.applyRemoteInvoice(row, summary, raw, {
            actor: null,
            source: "webhook",
            eventId: input.eventId,
        });
        return {
            result: applied.result,
            paypalInvoiceId,
            shipmentLeadId: row.shipmentLeadId,
        };
    }

    /**
     * Single reconciliation path for sync / send / webhook. Only a verified PAID
     * invoice with an exact-cents amount match can mark the shipment CUSTOMER_PAID.
     */
    private async applyRemoteInvoice(
        row: PayPalCustomerInvoice,
        summary: PayPalInvoiceSummary,
        raw: unknown,
        ctx: { actor: Actor | null; source: "sync" | "webhook" | "send"; eventId?: string }
    ): Promise<ApplyOutcome> {
        const now = new Date();
        const status = summary.status;
        const decision = decideInvoiceStatusTransition(row.status, status);
        if (decision.action === "ignore") {
            return { row, result: `ignored_${decision.reason}` };
        }

        const base: Prisma.PayPalCustomerInvoiceUpdateManyMutationInput = {
            status,
            lastSyncedAt: now,
            rawLatestJson: JSON.stringify(raw),
            hostedInvoiceUrl: summary.hostedInvoiceUrl || row.hostedInvoiceUrl,
        };
        const dueDate = parseDate(summary.dueDate);
        if (dueDate) base.dueDate = dueDate;
        if (status === "SENT" && !row.sentAt) base.sentAt = now;
        if (status === "CANCELLED" && !row.cancelledAt) base.cancelledAt = now;

        const totalDrift =
            summary.totalValue != null && !amountsMatchUsd(Number(summary.totalValue), row.totalUsd);
        if (totalDrift) {
            base.needsAccountingReview = true;
            base.lastError = "PayPal invoice total differs from the GreenOS invoice total";
        }

        if (status === "PAID") {
            return this.applyPaid(row, summary, base, ctx);
        }

        let result = "synced";
        if (status === "CANCELLED") result = "cancelled";
        else if (status === "REFUNDED") result = "refunded";
        else if (["MARKED_AS_PAID", "PARTIALLY_PAID"].includes(status)) {
            // Ambiguous money state: never auto-mark the shipment paid.
            base.needsAccountingReview = true;
            base.lastError = `PayPal invoice status ${status} requires Accounting review`;
            result = "needs_review";
        } else if (["PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"].includes(status)) {
            base.needsAccountingReview = true;
            base.lastError = `PayPal invoice status ${status} requires Accounting review`;
            result = "needs_review";
        }

        // Optimistic write: a concurrent state change wins and this stale event is skipped.
        const written = await prisma.payPalCustomerInvoice.updateMany({
            where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId, status: row.status },
            data: base,
        });
        if (written.count !== 1) {
            const current = await prisma.payPalCustomerInvoice.findUnique({
                where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
            });
            return { row: current || row, result: "ignored_concurrent_update" };
        }

        if (status === "REFUNDED" && row.paidAt) {
            await prisma.shipmentLead.updateMany({
                where: {
                    shipmentLeadId: row.shipmentLeadId,
                    paymentStatus: "CUSTOMER_PAID",
                },
                data: {
                    customerPaidAt: null,
                    customerPaidById: null,
                    paymentDate: null,
                    paymentStatus: "CUSTOMER_REFUNDED",
                },
            });
            await domainEventEngine
                .emit({
                    shipmentLeadId: row.shipmentLeadId,
                    eventType: "PAYPAL_INVOICE_REFUNDED",
                    title: "PayPal invoice refunded",
                    message: `PayPal invoice ${row.paypalInvoiceId} refunded`,
                    payload: { paypalInvoiceId: row.paypalInvoiceId, environment: row.environment },
                })
                .catch(() => null);
        }
        const fresh = await prisma.payPalCustomerInvoice.findUnique({
            where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
        });
        return { row: fresh || row, result };
    }

    private async applyPaid(
        row: PayPalCustomerInvoice,
        summary: PayPalInvoiceSummary,
        base: Prisma.PayPalCustomerInvoiceUpdateManyMutationInput,
        ctx: { actor: Actor | null; source: string; eventId?: string }
    ): Promise<ApplyOutcome> {
        if (row.paidAt) {
            await prisma.payPalCustomerInvoice.updateMany({
                where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
                data: {
                    lastSyncedAt: base.lastSyncedAt,
                    rawLatestJson: base.rawLatestJson,
                },
            });
            return { row, result: "already_paid" };
        }

        // Prefer the amount actually paid; fall back to the invoice amount.
        const paidMoney = summary.paidValue
            ? { value: summary.paidValue, currency_code: summary.paidCurrency || summary.currency }
            : summary.totalValue
              ? { value: summary.totalValue, currency_code: summary.currency }
              : null;
        try {
            verifyInvoicePaidAmount({
                expectedTotalUsd: row.totalUsd,
                currency: row.currency,
                invoiceAmount: paidMoney,
            });
        } catch (err) {
            await prisma.payPalCustomerInvoice.updateMany({
                where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
                data: {
                    ...base,
                    paidAt: null,
                    needsAccountingReview: true,
                    lastError: safeMessage(err),
                },
            });
            const fresh = await prisma.payPalCustomerInvoice.findUnique({
                where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
            });
            return { row: fresh || row, result: "paid_amount_mismatch_review" };
        }

        const now = new Date();
        const outcome = await prisma.$transaction(async (tx) => {
            const touched = await tx.payPalCustomerInvoice.updateMany({
                where: {
                    paypalCustomerInvoiceId: row.paypalCustomerInvoiceId,
                    paidAt: null,
                    status: { notIn: ["CANCELLED", "REFUNDED", "MARKED_AS_REFUNDED"] },
                },
                data: {
                    ...base,
                    status: "PAID",
                    paidAt: now,
                    paymentTransactionId: summary.transactionId || row.paymentTransactionId,
                    lastError: (base.lastError as string | undefined) ?? null,
                },
            });
            if (touched.count !== 1) return "not_applied" as const;

            const shipTouch = await tx.shipmentLead.updateMany({
                where: {
                    shipmentLeadId: row.shipmentLeadId,
                    customerPaidAt: null,
                    OR: [
                        { paymentStatus: null },
                        { paymentStatus: { notIn: [...SHIPMENT_PAID_BLOCKING_STATUSES] } },
                    ],
                },
                data: {
                    customerPaidAt: now,
                    customerPaidById:
                        ctx.actor?.userId && ctx.actor.userId !== "paypal-webhook"
                            ? ctx.actor.userId
                            : undefined,
                    paymentStatus: "CUSTOMER_PAID",
                    paymentDate: now,
                    accountingReadyForBilling: true,
                },
            });
            if (shipTouch.count !== 1) {
                await tx.payPalCustomerInvoice.updateMany({
                    where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
                    data: {
                        needsAccountingReview: true,
                        lastError:
                            "Invoice paid in PayPal but the shipment is already paid, reversed or refunded — not re-marking CUSTOMER_PAID",
                    },
                });
                return "paid_shipment_conflict" as const;
            }
            return "paid" as const;
        });

        const fresh = await prisma.payPalCustomerInvoice.findUnique({
            where: { paypalCustomerInvoiceId: row.paypalCustomerInvoiceId },
        });
        if (outcome === "paid") {
            await domainEventEngine
                .emit({
                    shipmentLeadId: row.shipmentLeadId,
                    eventType: "CUSTOMER_PAYMENT_RECEIVED",
                    title: "Customer Paid (PayPal invoice)",
                    message: `PayPal invoice ${row.paypalInvoiceId} paid`,
                    actorUserId:
                        ctx.actor?.userId && ctx.actor.userId !== "paypal-webhook"
                            ? ctx.actor.userId
                            : undefined,
                    payload: {
                        paypalInvoiceId: row.paypalInvoiceId,
                        paymentTransactionId: summary.transactionId,
                        amountUsd: row.totalUsd,
                        currency: row.currency,
                        environment: row.environment,
                        via: "paypal_invoice",
                    },
                })
                .catch(() => null);
            await writeAudit({
                actor: ctx.actor,
                auditUserId: row.createdByUserId,
                action: "PAYPAL_INVOICE_PAID",
                shipmentLeadId: row.shipmentLeadId,
                newValue: {
                    paypalInvoiceId: row.paypalInvoiceId,
                    paymentTransactionId: summary.transactionId,
                    amountUsd: row.totalUsd,
                    source: ctx.source,
                },
            });
        }
        return { row: fresh || row, result: outcome };
    }
}

export const payPalInvoicingService = new PayPalInvoicingService();

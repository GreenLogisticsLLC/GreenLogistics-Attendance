import { createHash } from "crypto";
import type { PayPalCustomerOrder } from "@prisma/client";
import { prisma } from "../../../config/database.js";
import {
    AccountingPermissions,
    hasAccountingPermission,
    type AccountingSubRole,
} from "../../../auth/accounting.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { customerPaymentQuote } from "../../shipment/customer-payment.js";
import {
    capturePayPalOrder,
    createPayPalOrder,
    getPayPalOrder,
    verifyPayPalWebhookSignature,
} from "./paypal-client.js";
import {
    runClaimedCapture,
    stateForPayPalStatus,
    verifyCompletedCapture,
    type CaptureEvidence,
} from "./paypal-payment-safety.js";
import { sendPayPalPaymentEmail } from "./paypal-payment-email.js";
import { config } from "../../../config/env.js";

type Actor = {
    userId: string;
    role: string;
    accountingSubRole?: AccountingSubRole | null;
};

const OPEN_STATUSES = new Set([
    "CREATED",
    "PAYER_ACTION_REQUIRED",
    "SAVED",
    "APPROVED",
    "CAPTURE_PENDING",
]);

function forbid(message: string, code = "ACCOUNTING_FORBIDDEN") {
    return Object.assign(new Error(message), { status: 403, code });
}

function badRequest(message: string, code = "ACCOUNTING_INVALID") {
    return Object.assign(new Error(message), { status: 422, code });
}

function notFound(message: string) {
    return Object.assign(new Error(message), { status: 404, code: "NOT_FOUND" });
}

function assertCanManagePayPalLinks(actor: Actor) {
    const ok =
        hasAccountingPermission(
            actor.role,
            actor.accountingSubRole,
            AccountingPermissions.BillingSend
        ) ||
        hasAccountingPermission(
            actor.role,
            actor.accountingSubRole,
            AccountingPermissions.CustomerPaymentsRecord
        );
    if (!ok) {
        throw forbid("You cannot generate or send PayPal payment links");
    }
}

function centsKey(amount: number): string {
    return Math.round(Number(amount) * 100).toString();
}

function mapRow(row: {
    paypalCustomerOrderId: string;
    paypalOrderId: string;
    invoiceNumber: string | null;
    customerName: string | null;
    customerEmail: string | null;
    amountUsd: number;
    currency: string;
    status: string;
    approvalUrl: string | null;
    captureId: string | null;
    captureRequestId: string | null;
    captureStartedAt: Date | null;
    captureCompletedAt: Date | null;
    refundId: string | null;
    refundedAt: Date | null;
    failureReason: string | null;
    createdByUserId: string | null;
    lastEmailSentAt: Date | null;
    lastEmailSentTo: string | null;
    paidAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        paypalCustomerOrderId: row.paypalCustomerOrderId,
        paypalOrderId: row.paypalOrderId,
        invoiceNumber: row.invoiceNumber,
        customerName: row.customerName,
        customerEmail: row.customerEmail,
        amountUsd: row.amountUsd,
        currency: row.currency,
        status: row.status,
        approvalUrl: row.approvalUrl,
        paymentUrl: row.approvalUrl,
        captureId: row.captureId,
        captureRequestId: row.captureRequestId,
        captureStartedAt: row.captureStartedAt,
        captureCompletedAt: row.captureCompletedAt,
        refundId: row.refundId,
        refundedAt: row.refundedAt,
        failureReason: row.failureReason,
        createdByUserId: row.createdByUserId,
        lastEmailSentAt: row.lastEmailSentAt,
        lastEmailSentTo: row.lastEmailSentTo,
        paidAt: row.paidAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        paypalMode: config.paypal.mode,
        paypalConfigured: config.paypal.configured,
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
                entityName: "PayPalCustomerOrder",
                entityId: input.shipmentLeadId,
                newValue: input.newValue != null ? JSON.stringify(input.newValue) : null,
            },
        });
    } catch {
        /* ignore audit failures */
    }
}

export class PayPalCheckoutService {
    async getLatestForShipment(shipmentLeadId: string) {
        const row = await prisma.payPalCustomerOrder.findFirst({
            where: { shipmentLeadId },
            orderBy: { createdAt: "desc" },
        });
        return row ? mapRow(row) : null;
    }

    /**
     * Create (or reuse) a PayPal Checkout order for the shipment's outstanding amount.
     * Amount always comes from customerPaymentQuote — never from the client.
     */
    async generatePaymentLink(actor: Actor, shipmentLeadId: string) {
        assertCanManagePayPalLinks(actor);
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        if (s.customerPaidAt) {
            throw badRequest("Customer is already marked paid on this load");
        }

        const quote = customerPaymentQuote({
            customerRate: s.customerRate,
            accessorialCharges: s.accessorialCharges,
            method: s.customerPaymentMethod,
            waiveFee: s.waiveCustomerPaymentFee,
        });
        if (quote.total == null || quote.total <= 0) {
            throw badRequest(
                "Customer payment amount is missing. Save Customer Rate (and payment option) first."
            );
        }

        const invoiceDoc = await prisma.loadDocument.findFirst({
            where: {
                shipmentLeadId,
                docType: "CUSTOMER_INVOICE",
                isCurrent: true,
                status: { not: "ARCHIVED" },
            },
            orderBy: { version: "desc" },
        });

        const invoiceNumber =
            String(s.invoiceNumber || "").trim() ||
            (s.loadNumber ? String(s.loadNumber).replace(/^GL/i, "INV-") : null);

        const idempotencyKey = createHash("sha256")
            .update(
                [
                    shipmentLeadId,
                    centsKey(quote.total),
                    invoiceNumber || "",
                    config.paypal.mode,
                ].join("|")
            )
            .digest("hex")
            .slice(0, 48);

        const existing = await prisma.payPalCustomerOrder.findFirst({
            where: {
                shipmentLeadId,
                idempotencyKey,
                status: { in: Array.from(OPEN_STATUSES) },
            },
            orderBy: { createdAt: "desc" },
        });
        if (existing?.approvalUrl) {
            return mapRow(existing);
        }

        const created = await createPayPalOrder({
            amountUsd: quote.total,
            currency: "USD",
            invoiceNumber,
            description: `Green Logistics ${s.loadNumber || shipmentLeadId.slice(0, 8)}`,
            customId: shipmentLeadId,
            idempotencyKey,
        });

        if (!created.approvalUrl) {
            throw Object.assign(
                new Error("PayPal order was created but no approval URL was returned"),
                { status: 502, code: "PAYPAL_APPROVAL_URL_MISSING" }
            );
        }

        const row = await prisma.payPalCustomerOrder.upsert({
            where: { idempotencyKey },
            create: {
                shipmentLeadId,
                paypalOrderId: created.id,
                invoiceNumber,
                customerInvoiceDocumentId: invoiceDoc?.documentId || null,
                customerName: s.customerName,
                customerEmail: s.customerEmail,
                amountUsd: quote.total,
                currency: "USD",
                status: created.status || "CREATED",
                approvalUrl: created.approvalUrl,
                idempotencyKey,
                createdByUserId: actor.userId,
                rawCreateJson: JSON.stringify(created.raw),
            },
            update: {
                paypalOrderId: created.id,
                status: created.status || "CREATED",
                approvalUrl: created.approvalUrl,
                amountUsd: quote.total,
                invoiceNumber,
                customerName: s.customerName,
                customerEmail: s.customerEmail,
                customerInvoiceDocumentId: invoiceDoc?.documentId || null,
                rawCreateJson: JSON.stringify(created.raw),
            },
        });

        await domainEventEngine
            .emit({
                shipmentLeadId,
                eventType: "PAYPAL_CHECKOUT_LINK_CREATED",
                title: "PayPal payment link created",
                message: `PayPal order ${created.id} for $${quote.total.toFixed(2)}`,
                actorUserId: actor.userId,
                payload: {
                    paypalOrderId: created.id,
                    amountUsd: quote.total,
                    approvalUrl: created.approvalUrl,
                },
            })
            .catch(() => null);
        await writeAudit({
            actor,
            action: "PAYPAL_LINK_GENERATED",
            shipmentLeadId,
            newValue: { paypalOrderId: created.id, amountUsd: quote.total },
        });

        return mapRow(row);
    }

    async refreshStatus(actor: Actor, shipmentLeadId: string) {
        assertCanManagePayPalLinks(actor);
        const row = await prisma.payPalCustomerOrder.findFirst({
            where: { shipmentLeadId },
            orderBy: { createdAt: "desc" },
        });
        if (!row) throw notFound("No PayPal payment link on this load yet");
        const remote = await getPayPalOrder(row.paypalOrderId);
        const updated = await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
            data: {
                status:
                    String(remote.captureStatus || "").toUpperCase() === "COMPLETED"
                        ? "CAPTURE_PENDING"
                        : String(remote.status || "").toUpperCase() === "COMPLETED"
                          ? "CAPTURE_PENDING"
                          : stateForPayPalStatus(remote.status),
                approvalUrl: remote.approvalUrl || row.approvalUrl,
            },
        });
        if (
            !updated.paidAt &&
            (String(remote.status || "").toUpperCase() === "APPROVED" ||
                String(remote.captureStatus || "").toUpperCase() === "COMPLETED")
        ) {
            await this.captureAndMarkPaid(updated.paypalOrderId, actor);
            const fresh = await prisma.payPalCustomerOrder.findUnique({
                where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
            });
            return fresh ? mapRow(fresh) : mapRow(updated);
        }
        return mapRow(updated);
    }

    async sendPaymentLinkEmail(actor: Actor, shipmentLeadId: string) {
        assertCanManagePayPalLinks(actor);
        let row = await prisma.payPalCustomerOrder.findFirst({
            where: { shipmentLeadId },
            orderBy: { createdAt: "desc" },
        });
        if (!row?.approvalUrl) {
            await this.generatePaymentLink(actor, shipmentLeadId);
            row = await prisma.payPalCustomerOrder.findFirst({
                where: { shipmentLeadId },
                orderBy: { createdAt: "desc" },
            });
        }
        if (!row?.approvalUrl) {
            throw badRequest("Generate a PayPal payment link before sending email");
        }
        const s = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!s) throw notFound("Shipment not found");
        const to = String(row.customerEmail || s.customerEmail || "").trim();
        if (!to || !to.includes("@")) {
            throw badRequest(
                "Customer email is missing on this load. Add the customer email, then send again."
            );
        }
        const mail = await sendPayPalPaymentEmail({
            to,
            customerName: row.customerName || s.customerName,
            loadNumber: s.loadNumber,
            invoiceNumber: row.invoiceNumber,
            amountUsd: row.amountUsd,
            approvalUrl: row.approvalUrl,
        });
        const updated = await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
            data: {
                lastEmailSentAt: new Date(),
                lastEmailSentTo: to,
            },
        });
        await writeAudit({
            actor,
            action: "PAYPAL_LINK_EMAILED",
            shipmentLeadId,
            newValue: { to, from: mail.from, paypalOrderId: row.paypalOrderId },
        });
        return { ...mapRow(updated), emailTo: to, emailFrom: mail.from };
    }

    private captureRequestId(paypalOrderId: string): string {
        return createHash("sha256")
            .update(`greenos-paypal-capture|${paypalOrderId}`)
            .digest("hex")
            .slice(0, 48);
    }

    /**
     * This is the only path that marks a PayPal payment received. It requires
     * strict COMPLETED capture evidence with exact USD amount equality.
     */
    private async finalizeCompletedCapture(input: {
        row: PayPalCustomerOrder;
        evidence: CaptureEvidence;
        raw: unknown;
        actor?: Actor | null;
    }) {
        if (input.row.status === "REFUNDED" || input.row.refundedAt) {
            throw badRequest(
                "A refunded PayPal payment cannot be marked completed",
                "PAYPAL_CAPTURE_REFUNDED"
            );
        }
        const verified = verifyCompletedCapture(input.evidence, {
            amountUsd: input.row.amountUsd,
            currency: input.row.currency,
        });
        const now = new Date();
        const result = await prisma.$transaction(async (tx) => {
            const current = await tx.payPalCustomerOrder.findUnique({
                where: { paypalCustomerOrderId: input.row.paypalCustomerOrderId },
            });
            if (!current) throw notFound("PayPal order not found");
            if (current.status === "REFUNDED" || current.refundedAt) {
                throw badRequest(
                    "A refunded PayPal payment cannot be marked completed",
                    "PAYPAL_CAPTURE_REFUNDED"
                );
            }
            const updated = await tx.payPalCustomerOrder.update({
                where: { paypalCustomerOrderId: current.paypalCustomerOrderId },
                data: {
                    status: "COMPLETED",
                    captureId: verified.captureId,
                    captureCompletedAt: current.captureCompletedAt || now,
                    paidAt: current.paidAt || now,
                    failureReason: null,
                    rawCaptureJson: JSON.stringify(input.raw),
                },
            });
            const lead = await tx.shipmentLead.findUnique({
                where: { shipmentLeadId: current.shipmentLeadId },
            });
            if (lead && !lead.customerPaidAt) {
                await tx.shipmentLead.update({
                    where: { shipmentLeadId: current.shipmentLeadId },
                    data: {
                        customerPaidAt: now,
                        customerPaidById:
                            input.actor?.userId && input.actor.userId !== "paypal-webhook"
                                ? input.actor.userId
                                : lead.customerPaidById || null,
                        paymentStatus: "CUSTOMER_PAID",
                        paymentDate: now,
                        accountingReadyForBilling: true,
                    },
                });
            }
            return { updated, newlyPaid: Boolean(lead && !lead.customerPaidAt) };
        });

        if (result.newlyPaid) {
            await domainEventEngine
                .emit({
                    shipmentLeadId: input.row.shipmentLeadId,
                    eventType: "CUSTOMER_PAYMENT_RECEIVED",
                    title: "Customer Paid (PayPal)",
                    message: `PayPal capture ${verified.captureId} completed`,
                    actorUserId:
                        input.actor?.userId === "paypal-webhook"
                            ? undefined
                            : input.actor?.userId,
                    payload: {
                        paypalOrderId: input.row.paypalOrderId,
                        captureId: verified.captureId,
                        amountUsd: verified.amountUsd,
                        currency: verified.currency,
                        via: "paypal",
                    },
                })
                .catch(() => null);
        }
        await writeAudit({
            actor:
                input.actor?.userId === "paypal-webhook" ? null : input.actor || null,
            auditUserId: input.row.createdByUserId,
            action: "PAYPAL_CAPTURE_COMPLETED",
            shipmentLeadId: input.row.shipmentLeadId,
            newValue: {
                paypalOrderId: input.row.paypalOrderId,
                captureId: verified.captureId,
                status: "COMPLETED",
                amountUsd: verified.amountUsd,
                currency: verified.currency,
            },
        });
        return mapRow(result.updated);
    }

    private async reconcileCapture(
        row: PayPalCustomerOrder,
        actor?: Actor | null
    ) {
        const remote = await getPayPalOrder(row.paypalOrderId);
        if (String(remote.captureStatus || "").toUpperCase() === "COMPLETED") {
            return this.finalizeCompletedCapture({
                row,
                evidence: {
                    captureId: remote.captureId,
                    status: remote.captureStatus,
                    amountValue: remote.amountValue,
                    currencyCode: remote.currencyCode,
                },
                raw: remote.raw,
                actor,
            });
        }
        const state =
            row.status === "CAPTURE_PENDING" &&
            String(remote.status || "").toUpperCase() === "APPROVED"
                ? "CAPTURE_PENDING"
                : String(remote.status || "").toUpperCase() === "COMPLETED"
                  ? "CAPTURE_PENDING"
                  : stateForPayPalStatus(remote.captureStatus || remote.status);
        const updated = await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
            data: {
                status: state,
                approvalUrl: remote.approvalUrl || row.approvalUrl,
                captureId: remote.captureId || row.captureId,
                rawCaptureJson: JSON.stringify(remote.raw),
            },
        });
        return mapRow(updated);
    }

    async captureAndMarkPaid(paypalOrderId: string, actor?: Actor | null) {
        let row = await prisma.payPalCustomerOrder.findUnique({
            where: { paypalOrderId },
        });
        if (!row) throw notFound("PayPal order not found");
        if (row.status === "REFUNDED" || row.refundedAt) {
            throw badRequest("PayPal payment was refunded", "PAYPAL_CAPTURE_REFUNDED");
        }
        if (row.status === "COMPLETED" && row.paidAt) return mapRow(row);

        const remote = await getPayPalOrder(paypalOrderId);
        if (String(remote.captureStatus || "").toUpperCase() === "COMPLETED") {
            return this.finalizeCompletedCapture({
                row,
                evidence: {
                    captureId: remote.captureId,
                    status: remote.captureStatus,
                    amountValue: remote.amountValue,
                    currencyCode: remote.currencyCode,
                },
                raw: remote.raw,
                actor,
            });
        }

        const remoteState = stateForPayPalStatus(remote.status);
        if (remoteState !== "APPROVED" && row.status !== "CAPTURE_PENDING") {
            const updated = await prisma.payPalCustomerOrder.update({
                where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                data: { status: remoteState, rawCaptureJson: JSON.stringify(remote.raw) },
            });
            return mapRow(updated);
        }

        if (row.status !== "CAPTURE_PENDING") {
            row = await prisma.payPalCustomerOrder.update({
                where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                data: { status: "APPROVED" },
            });
        }

        const requestId = row.captureRequestId || this.captureRequestId(paypalOrderId);
        const staleBefore = new Date(Date.now() - 30_000);
        const claim = await prisma.payPalCustomerOrder.updateMany({
            where: {
                paypalCustomerOrderId: row.paypalCustomerOrderId,
                paidAt: null,
                refundedAt: null,
                OR: [
                    { status: "APPROVED" },
                    {
                        status: "CAPTURE_PENDING",
                        captureStartedAt: { lte: staleBefore },
                    },
                ],
            },
            data: {
                status: "CAPTURE_PENDING",
                captureRequestId: requestId,
                captureStartedAt: new Date(),
                failureReason: null,
            },
        });

        return runClaimedCapture({
            claim: async () => claim.count === 1,
            reconcile: async () => {
                const current = await prisma.payPalCustomerOrder.findUnique({
                    where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                });
                if (!current) throw notFound("PayPal order not found");
                return this.reconcileCapture(current, actor);
            },
            capture: async () => {
                try {
                    const capture = await capturePayPalOrder(paypalOrderId, requestId);
                    const captureState = capture.captureStatus
                        ? stateForPayPalStatus(capture.captureStatus)
                        : "FAILED";
                    if (
                        String(capture.captureStatus || "").toUpperCase() !== "COMPLETED"
                    ) {
                        const updated = await prisma.payPalCustomerOrder.update({
                            where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                            data: {
                                status: captureState,
                                captureId: capture.captureId,
                                failureReason: `Capture status ${capture.captureStatus || capture.status || "unknown"}`,
                                rawCaptureJson: JSON.stringify(capture.raw),
                            },
                        });
                        return mapRow(updated);
                    }
                    return this.finalizeCompletedCapture({
                        row,
                        evidence: {
                            captureId: capture.captureId,
                            status: capture.captureStatus,
                            amountValue: capture.amountValue,
                            currencyCode: capture.currencyCode,
                        },
                        raw: capture.raw,
                        actor,
                    });
                } catch (err) {
                    const code = (err as { code?: string })?.code;
                    const validationFailure =
                        code === "PAYPAL_CAPTURE_NOT_COMPLETED" ||
                        code === "PAYPAL_CAPTURE_ID_MISSING" ||
                        code === "PAYPAL_CAPTURE_CURRENCY_MISMATCH" ||
                        code === "PAYPAL_CAPTURE_AMOUNT_MISMATCH";
                    await prisma.payPalCustomerOrder
                        .update({
                            where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                            data: {
                                status: validationFailure
                                    ? "FAILED"
                                    : "CAPTURE_PENDING",
                                failureReason:
                                    err instanceof Error
                                        ? err.message.slice(0, 500)
                                        : "PayPal capture request failed",
                            },
                        })
                        .catch(() => null);
                    throw err;
                }
            },
        });
    }

    async handleWebhook(input: {
        headers: Record<string, string | string[] | undefined>;
        rawBody: string;
    }) {
        const ok = await verifyPayPalWebhookSignature(input);
        if (!ok) {
            throw Object.assign(new Error("PayPal webhook signature verification failed"), {
                status: 401,
                code: "PAYPAL_WEBHOOK_INVALID",
            });
        }

        let payload: {
            id?: string;
            event_type?: string;
            resource?: {
                id?: string;
                status?: string;
                amount?: { value?: string; currency_code?: string };
                supplementary_data?: { related_ids?: { order_id?: string } };
                purchase_units?: Array<{
                    payments?: { captures?: Array<{ id?: string }> };
                }>;
            };
        };
        try {
            payload = JSON.parse(input.rawBody);
        } catch {
            throw badRequest("Invalid PayPal webhook JSON");
        }

        const eventId = String(payload.id || "").trim();
        const eventType = String(payload.event_type || "").trim();
        if (!eventId || !eventType) {
            throw badRequest("PayPal webhook missing event id/type");
        }

        const existing = await prisma.payPalWebhookEvent.findUnique({ where: { eventId } });
        if (existing?.processed) {
            return { duplicate: true, eventId, eventType, result: existing.processResult };
        }

        const resource = payload.resource || {};
        let paypalOrderId =
            resource.supplementary_data?.related_ids?.order_id ||
            (eventType.startsWith("CHECKOUT.ORDER.") ? resource.id : null) ||
            null;

        if (!paypalOrderId && resource.id) {
            const byCapture = await prisma.payPalCustomerOrder.findFirst({
                where: { captureId: resource.id },
            });
            paypalOrderId = byCapture?.paypalOrderId || null;
        }

        let eventRow = await prisma.payPalWebhookEvent.upsert({
            where: { eventId },
            create: {
                eventId,
                eventType,
                paypalOrderId,
                resourceId: resource.id || null,
                processed: false,
                rawPayloadJson: input.rawBody,
            },
            update: {
                eventType,
                paypalOrderId,
                resourceId: resource.id || null,
                rawPayloadJson: input.rawBody,
            },
        });
        if (eventRow.processResult === "PROCESSING") {
            return { duplicate: true, eventId, eventType, result: "processing" };
        }
        if (eventRow.processResult?.startsWith("error:")) {
            eventRow = await prisma.payPalWebhookEvent.update({
                where: { paypalWebhookEventId: eventRow.paypalWebhookEventId },
                data: { processResult: null },
            });
        }
        const claim = await prisma.payPalWebhookEvent.updateMany({
            where: {
                paypalWebhookEventId: eventRow.paypalWebhookEventId,
                processed: false,
                processResult: null,
            },
            data: { processResult: "PROCESSING" },
        });
        if (claim.count !== 1) {
            return { duplicate: true, eventId, eventType, result: "processing" };
        }

        let result = "ignored";
        try {
            if (eventType === "CHECKOUT.ORDER.APPROVED") {
                if (!paypalOrderId) throw badRequest("Webhook missing PayPal order id");
                await prisma.payPalCustomerOrder.updateMany({
                    where: {
                        paypalOrderId,
                        paidAt: null,
                        refundedAt: null,
                    },
                    data: { status: "APPROVED", failureReason: null },
                });
                result = "approved";
            } else if (eventType === "CHECKOUT.ORDER.COMPLETED") {
                if (!paypalOrderId) throw badRequest("Webhook missing PayPal order id");
                // Order-level completion alone is not payment proof. The signed
                // capture event (or GET reconciliation) supplies capture evidence.
                await prisma.payPalCustomerOrder.updateMany({
                    where: {
                        paypalOrderId,
                        paidAt: null,
                        refundedAt: null,
                    },
                    data: { status: "CAPTURE_PENDING" },
                });
                result = "awaiting_capture_confirmation";
            } else if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
                const captureId = String(resource.id || "").trim();
                if (!paypalOrderId || !captureId) {
                    throw badRequest("Capture webhook missing order id or capture id");
                }
                const row = await prisma.payPalCustomerOrder.findUnique({
                    where: { paypalOrderId },
                });
                if (!row) throw notFound("PayPal order not found");

                // Validate signed webhook evidence before any GreenOS state update.
                verifyCompletedCapture(
                    {
                        captureId,
                        status: resource.status,
                        amountValue: resource.amount?.value,
                        currencyCode: resource.amount?.currency_code,
                    },
                    { amountUsd: row.amountUsd, currency: row.currency }
                );

                // GET is read-only and verifies that the capture belongs to the
                // expected PayPal order. Webhook handling never calls Capture.
                const remote = await getPayPalOrder(paypalOrderId);
                if (remote.id !== paypalOrderId || remote.captureId !== captureId) {
                    throw badRequest(
                        "PayPal capture does not belong to the expected order",
                        "PAYPAL_CAPTURE_ORDER_MISMATCH"
                    );
                }
                await this.finalizeCompletedCapture({
                    row,
                    evidence: {
                        captureId: remote.captureId,
                        status: remote.captureStatus,
                        amountValue: remote.amountValue,
                        currencyCode: remote.currencyCode,
                    },
                    raw: payload,
                    actor: {
                        userId: "paypal-webhook",
                        role: "Accounting",
                        accountingSubRole: null,
                    },
                });
                result = row.paidAt ? "already_completed" : "completed";
            } else if (eventType === "PAYMENT.CAPTURE.PENDING") {
                if (paypalOrderId) {
                    await prisma.payPalCustomerOrder.updateMany({
                        where: { paypalOrderId, paidAt: null, refundedAt: null },
                        data: { status: "CAPTURE_PENDING" },
                    });
                }
                result = "capture_pending";
            } else if (eventType === "PAYMENT.CAPTURE.DENIED") {
                if (paypalOrderId) {
                    await prisma.payPalCustomerOrder.updateMany({
                        where: { paypalOrderId, paidAt: null, refundedAt: null },
                        data: {
                            status: "DENIED",
                            failureReason: "PayPal capture denied",
                        },
                    });
                }
                result = "denied";
            } else if (eventType === "CHECKOUT.ORDER.VOIDED") {
                if (paypalOrderId) {
                    await prisma.payPalCustomerOrder.updateMany({
                        where: { paypalOrderId, paidAt: null, refundedAt: null },
                        data: { status: "CANCELLED" },
                    });
                }
                result = "cancelled";
            } else if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
                if (!paypalOrderId) {
                    throw badRequest("Refund webhook missing PayPal order id");
                }
                const row = await prisma.payPalCustomerOrder.findUnique({
                    where: { paypalOrderId },
                });
                if (!row) throw notFound("PayPal order not found");
                const currency = String(resource.amount?.currency_code || "").toUpperCase();
                const refundAmount = Number(resource.amount?.value);
                if (
                    currency !== "USD" ||
                    !Number.isFinite(refundAmount) ||
                    refundAmount <= 0 ||
                    Math.round(refundAmount * 100) > Math.round(row.amountUsd * 100)
                ) {
                    throw badRequest(
                        "Refund amount or currency is invalid",
                        "PAYPAL_REFUND_AMOUNT_INVALID"
                    );
                }
                const now = new Date();
                await prisma.$transaction([
                    prisma.payPalCustomerOrder.update({
                        where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                        data: {
                            status: "REFUNDED",
                            refundId: resource.id || eventId,
                            refundedAt: now,
                            failureReason: null,
                        },
                    }),
                    prisma.shipmentLead.update({
                        where: { shipmentLeadId: row.shipmentLeadId },
                        data: {
                            customerPaidAt: null,
                            customerPaidById: null,
                            paymentDate: null,
                            paymentStatus: "CUSTOMER_REFUNDED",
                        },
                    }),
                ]);
                await writeAudit({
                    actor: null,
                    auditUserId: row.createdByUserId,
                    action: "PAYPAL_CAPTURE_REFUNDED",
                    shipmentLeadId: row.shipmentLeadId,
                    newValue: {
                        paypalOrderId,
                        captureId: row.captureId,
                        refundId: resource.id || eventId,
                        refundAmount,
                        currency,
                    },
                });
                result = "refunded";
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await prisma.payPalWebhookEvent.update({
                where: { paypalWebhookEventId: eventRow.paypalWebhookEventId },
                data: { processResult: `error:${message}` },
            });
            throw err;
        }

        await prisma.payPalWebhookEvent.update({
            where: { paypalWebhookEventId: eventRow.paypalWebhookEventId },
            data: { processed: true, processResult: result },
        });
        return { duplicate: false, eventId, eventType, result, paypalOrderId };
    }
}

export const payPalCheckoutService = new PayPalCheckoutService();

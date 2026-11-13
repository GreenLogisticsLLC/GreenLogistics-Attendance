import { createHash } from "crypto";
import { prisma } from "../../../config/database.js";
import {
    AccountingPermissions,
    hasAccountingPermission,
    type AccountingSubRole,
} from "../../../auth/accounting.js";
import { Roles } from "../../../auth/roles.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { customerPaymentQuote } from "../../shipment/customer-payment.js";
import {
    capturePayPalOrder,
    createPayPalOrder,
    getPayPalOrder,
    verifyPayPalWebhookSignature,
} from "./paypal-client.js";
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
    action: string;
    shipmentLeadId: string;
    newValue?: unknown;
}) {
    try {
        await prisma.auditLog.create({
            data: {
                userId: input.actor?.userId || "system",
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
                status: remote.status || row.status,
                approvalUrl: remote.approvalUrl || row.approvalUrl,
            },
        });
        if (String(remote.status || "").toUpperCase() === "APPROVED" && !updated.paidAt) {
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

    async captureAndMarkPaid(paypalOrderId: string, actor?: Actor | null) {
        const row = await prisma.payPalCustomerOrder.findUnique({
            where: { paypalOrderId },
        });
        if (!row) throw notFound("PayPal order not found");
        if (row.paidAt) return mapRow(row);

        const capture = await capturePayPalOrder(paypalOrderId);
        const status = String(capture.status || "").toUpperCase();
        if (status !== "COMPLETED" && !capture.captureId) {
            await prisma.payPalCustomerOrder.update({
                where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
                data: {
                    status: capture.status || row.status,
                    rawCaptureJson: JSON.stringify(capture.raw),
                },
            });
            throw badRequest(
                `PayPal capture did not complete (status ${capture.status || "unknown"})`,
                "PAYPAL_CAPTURE_INCOMPLETE"
            );
        }

        const now = new Date();
        const updated = await prisma.payPalCustomerOrder.update({
            where: { paypalCustomerOrderId: row.paypalCustomerOrderId },
            data: {
                status: "COMPLETED",
                captureId: capture.captureId,
                paidAt: now,
                rawCaptureJson: JSON.stringify(capture.raw),
            },
        });

        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: row.shipmentLeadId },
        });
        if (lead && !lead.customerPaidAt) {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId: row.shipmentLeadId },
                data: {
                    customerPaidAt: now,
                    customerPaidById: actor?.userId || lead.customerPaidById || null,
                    paymentStatus: "CUSTOMER_PAID",
                    paymentDate: now,
                    accountingReadyForBilling: true,
                },
            });
            await domainEventEngine
                .emit({
                    shipmentLeadId: row.shipmentLeadId,
                    eventType: "CUSTOMER_PAYMENT_RECEIVED",
                    title: "Customer Paid (PayPal)",
                    message: `PayPal capture ${capture.captureId || capture.id} completed`,
                    actorUserId: actor?.userId,
                    payload: {
                        paypalOrderId,
                        captureId: capture.captureId,
                        amountUsd: row.amountUsd,
                        via: "paypal",
                    },
                })
                .catch(() => null);
        }
        await writeAudit({
            actor: actor || null,
            action: "PAYPAL_CAPTURE_COMPLETED",
            shipmentLeadId: row.shipmentLeadId,
            newValue: { paypalOrderId, captureId: capture.captureId, status },
        });
        return mapRow(updated);
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

        const eventRow = await prisma.payPalWebhookEvent.upsert({
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

        let result = "ignored";
        try {
            if (
                eventType === "CHECKOUT.ORDER.APPROVED" ||
                eventType === "CHECKOUT.ORDER.COMPLETED"
            ) {
                if (!paypalOrderId) throw badRequest("Webhook missing PayPal order id");
                await this.captureAndMarkPaid(paypalOrderId, {
                    userId: "paypal-webhook",
                    role: Roles.Accounting,
                    accountingSubRole: null,
                });
                result = "captured";
            } else if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
                if (paypalOrderId) {
                    const row = await prisma.payPalCustomerOrder.findUnique({
                        where: { paypalOrderId },
                    });
                    if (row && !row.paidAt) {
                        await this.captureAndMarkPaid(paypalOrderId, {
                            userId: "paypal-webhook",
                            role: Roles.Accounting,
                            accountingSubRole: null,
                        });
                        result = "captured";
                    } else {
                        result = "already_paid_or_missing";
                    }
                } else {
                    result = "no_order_id";
                }
            } else if (
                eventType === "CHECKOUT.ORDER.VOIDED" ||
                eventType === "PAYMENT.CAPTURE.DENIED" ||
                eventType === "PAYMENT.CAPTURE.REFUNDED"
            ) {
                if (paypalOrderId) {
                    await prisma.payPalCustomerOrder.updateMany({
                        where: { paypalOrderId, paidAt: null },
                        data: {
                            status:
                                eventType === "CHECKOUT.ORDER.VOIDED" ? "VOIDED" : "FAILED",
                        },
                    });
                    result = "status_updated";
                }
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

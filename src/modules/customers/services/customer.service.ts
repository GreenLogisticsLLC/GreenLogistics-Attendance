import { prisma } from "../../../config/database.js";
import { isDataScopedRole, isTeamScopedRole, Roles } from "../../../auth/roles.js";
import { allocateGreenOsShipmentId } from "../../shipment/shipment.id.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";
import { domainEventEngine } from "../../shipment/services/domain-event.engine.js";
import { brokerGmailOAuthService } from "../../email/gmail/broker-gmail-oauth.service.js";
import { buildCustomerLoadNumberEmail } from "../customer-load-number-email.js";
import {
    buildCustomerAgreementEmail,
    normalizeCustomerAgreementType,
    type CustomerAgreementType,
} from "../customer-agreement.js";
import { customerAgreementInviteService } from "./customer-agreement-invite.service.js";
import { config } from "../../../config/env.js";

type Actor = { userId: string; role: string };

function str(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
}

function bool(v: unknown, fallback = false): boolean {
    if (v === true || v === 1 || v === "1" || v === "true") return true;
    if (v === false || v === 0 || v === "0" || v === "false") return false;
    return fallback;
}

function num(v: unknown): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
}

function dateVal(v: unknown): Date | null {
    const s = str(v);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

export class CustomerService {
    private async visibleCreatorIds(actor: Actor): Promise<string[] | null> {
        if (!isDataScopedRole(actor.role) && !isTeamScopedRole(actor.role)) return null;
        if (isDataScopedRole(actor.role)) return [actor.userId];
        const team = await prisma.user.findMany({
            where: { teamLeadId: actor.userId },
            select: { userId: true },
        });
        return [actor.userId, ...team.map((u) => u.userId)];
    }

    private async assertVisible(customerId: string, actor: Actor) {
        const row = await prisma.directCustomer.findUnique({ where: { customerId } });
        if (!row) {
            throw Object.assign(new Error("Customer not found"), { status: 404 });
        }
        const ids = await this.visibleCreatorIds(actor);
        if (ids && !ids.includes(row.createdByUserId)) {
            throw Object.assign(new Error("Customer not found"), { status: 404 });
        }
        return row;
    }

    async list(actor: Actor, q?: string) {
        const ids = await this.visibleCreatorIds(actor);
        const where: Record<string, unknown> = {};
        if (ids) where.createdByUserId = { in: ids };
        const query = str(q);
        if (query) {
            where.OR = [
                { companyName: { contains: query } },
                { contactName: { contains: query } },
                { email: { contains: query } },
                { phone: { contains: query } },
            ];
        }
        const rows = await prisma.directCustomer.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            take: 300,
        });
        const counts = await prisma.shipmentLead.groupBy({
            by: ["directCustomerId"],
            where: {
                directCustomerId: { in: rows.map((r) => r.customerId) },
            },
            _count: { _all: true },
        });
        const countMap = new Map(
            counts
                .filter((c) => c.directCustomerId)
                .map((c) => [c.directCustomerId as string, c._count._all])
        );
        return rows.map((r) => ({
            ...r,
            loadCount: countMap.get(r.customerId) || 0,
        }));
    }

    async get(customerId: string, actor: Actor) {
        const row = await this.assertVisible(customerId, actor);
        const loads = await prisma.shipmentLead.findMany({
            where: { directCustomerId: customerId },
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
                shipmentLeadId: true,
                loadNumber: true,
                greenOsShipmentId: true,
                shipmentTitle: true,
                status: true,
                pickupCity: true,
                pickupState: true,
                deliveryCity: true,
                deliveryState: true,
                createdAt: true,
            },
        });
        return { ...row, loads };
    }

    async create(body: Record<string, unknown>, actor: Actor) {
        const companyName = str(body.companyName);
        if (!companyName) {
            throw Object.assign(new Error("Company name is required"), { status: 422 });
        }
        return prisma.directCustomer.create({
            data: {
                companyName,
                contactName: str(body.contactName),
                email: str(body.email),
                phone: str(body.phone),
                billingAddress: str(body.billingAddress),
                city: str(body.city),
                state: str(body.state),
                zip: str(body.zip),
                notes: str(body.notes),
                sendLoadNumber: bool(body.sendLoadNumber, false),
                agreementType: normalizeCustomerAgreementType(body.agreementType),
                createdByUserId: actor.userId,
            },
        });
    }

    async update(customerId: string, body: Record<string, unknown>, actor: Actor) {
        await this.assertVisible(customerId, actor);
        const data: Record<string, unknown> = {};
        if (body.companyName !== undefined) {
            const name = str(body.companyName);
            if (!name) throw Object.assign(new Error("Company name is required"), { status: 422 });
            data.companyName = name;
        }
        for (const key of ["contactName", "email", "phone", "billingAddress", "city", "state", "zip", "notes"]) {
            if (body[key] !== undefined) data[key] = str(body[key]);
        }
        if (body.sendLoadNumber !== undefined) {
            data.sendLoadNumber = bool(body.sendLoadNumber, false);
        }
        if (body.agreementType !== undefined) {
            data.agreementType = normalizeCustomerAgreementType(body.agreementType);
        }
        return prisma.directCustomer.update({ where: { customerId }, data });
    }

    private async sendCustomerAgreementEmail(input: {
        brokerUserId: string;
        toEmail: string | null;
        companyName: string;
        agreementType: CustomerAgreementType;
        customerId: string;
        contactName?: string | null;
        phone?: string | null;
        billingAddress?: string | null;
        city?: string | null;
        state?: string | null;
        zip?: string | null;
    }): Promise<{
        sent: boolean;
        to?: string;
        from?: string;
        error?: string;
        label?: string;
        signUrl?: string;
    }> {
        const to = str(input.toEmail);
        if (!to) {
            return { sent: false, error: "Customer email is required" };
        }
        let invite: Awaited<ReturnType<typeof customerAgreementInviteService.createInvite>> | null =
            null;
        try {
            invite = await customerAgreementInviteService.createInvite({
                customerId: input.customerId,
                agreementType: input.agreementType,
                brokerUserId: input.brokerUserId,
                companyName: input.companyName,
                contactName: input.contactName,
                email: to,
                phone: input.phone,
                billingAddress: input.billingAddress,
                city: input.city,
                state: input.state,
                zip: input.zip,
            });
            const sentDateLabel = new Intl.DateTimeFormat("en-US", {
                timeZone: config.timezone || "America/Los_Angeles",
                year: "numeric",
                month: "long",
                day: "numeric",
            }).format(invite.sentAt);
            const mail = buildCustomerAgreementEmail({
                companyName: input.companyName,
                agreementType: input.agreementType,
                signUrl: invite.signUrl,
                brokerName: invite.brokerName,
                sentDateLabel,
            });
            const sent = await brokerGmailOAuthService.sendMailAsBroker(input.brokerUserId, {
                to,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                attachments: [
                    {
                        filename: invite.pdfFilename,
                        content: invite.pdf,
                        contentType: "application/pdf",
                    },
                ],
            });
            return {
                sent: true,
                to,
                from: sent.from,
                label: invite.label,
                signUrl: invite.signUrl,
            };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.warn("[customers] send agreement email failed:", error);
            // Keep the invite + sign link even when Gmail send fails so the broker can still share it.
            return {
                sent: false,
                to,
                error,
                label: invite?.label,
                signUrl: invite?.signUrl,
            };
        }
    }

    /** Main account only. Unlinks loads, then removes the direct customer. */
    async remove(customerId: string, actor: Actor) {
        if (actor.role !== Roles.Owner && actor.role !== Roles.Administrator) {
            throw Object.assign(new Error("Only the main account can delete a customer"), { status: 403 });
        }
        const row = await prisma.directCustomer.findUnique({ where: { customerId } });
        if (!row) throw Object.assign(new Error("Customer not found"), { status: 404 });
        await prisma.shipmentLead.updateMany({
            where: { directCustomerId: customerId },
            data: { directCustomerId: null },
        });
        await prisma.directCustomer.delete({ where: { customerId } });
        return { customerId, companyName: row.companyName };
    }

    /**
     * Create a new lot + Load Number from a Direct Customer (skips uShip).
     * Broker is assigned immediately; GL# is allocated after Accepted.
     */
    async createLoad(customerId: string, body: Record<string, unknown>, actor: Actor) {
        const customer = await this.assertVisible(customerId, actor);
        const pickupCity = str(body.pickupCity);
        const deliveryCity = str(body.deliveryCity);
        if (!pickupCity || !deliveryCity) {
            throw Object.assign(new Error("Pickup city and delivery city are required"), { status: 422 });
        }

        const customerName = str(body.customerName) || customer.companyName;
        const title =
            str(body.shipmentTitle) ||
            `${customerName} ${pickupCity} → ${deliveryCity}`;
        const pickupFrom = dateVal(body.pickupFrom) || dateVal(body.pickupDate);
        const deliveryFrom = dateVal(body.deliveryFrom) || dateVal(body.deliveryDate);
        const customerRate = num(body.customerRate);
        const greenOsShipmentId = await allocateGreenOsShipmentId();
        const now = new Date();
        const brokerId =
            actor.role === Roles.Broker ? actor.userId : str(body.assignedBrokerId) || actor.userId;

        const lead = await prisma.shipmentLead.create({
            data: {
                greenOsShipmentId,
                source: "direct_customer",
                shipmentTitle: title,
                customerName,
                customerEmail: str(body.customerEmail) || customer.email,
                customerPhone: str(body.customerPhone) || customer.phone,
                pickupCity,
                pickupState: str(body.pickupState),
                pickupZip: str(body.pickupZip),
                deliveryCity,
                deliveryState: str(body.deliveryState),
                deliveryZip: str(body.deliveryZip),
                pickupFrom,
                deliveryFrom,
                opsPickupAt: pickupFrom,
                opsDeliveryAt: deliveryFrom,
                miles: num(body.miles),
                equipment: str(body.equipment),
                commodity: str(body.commodity) || str(body.vehicle),
                weight: str(body.weight),
                pieces: num(body.pieces) != null ? Math.round(num(body.pieces) as number) : null,
                specialInstructions: str(body.specialInstructions),
                notes: str(body.notes),
                customerRate,
                price: customerRate,
                status: "ACCEPTED",
                acceptedAt: now,
                assignedBrokerId: brokerId,
                assignedAt: now,
                receivedAt: now,
                directCustomerId: customer.customerId,
                priority: "NORMAL",
                // A customer load is not a passed shipment. It becomes Load Created.
                isReassignment: false,
                wasEverReassigned: false,
            },
        });

        await shipmentService.markImported(lead.shipmentLeadId, {
            source: "direct_customer",
            customerId: customer.customerId,
            greenOsShipmentId,
        });
        await domainEventEngine.emit({
            shipmentLeadId: lead.shipmentLeadId,
            eventType: "CUSTOMER_ACCEPTED",
            title: "Direct Customer Load",
            message: `Direct lot from ${customerName}`,
            actorUserId: actor.userId,
            payload: { source: "direct_customer", customerId: customer.customerId },
            timelineStage: "CUSTOMER_ACCEPTED",
        });

        const loaded = await shipmentService.createLoadAfterAccepted({
            shipmentLeadId: lead.shipmentLeadId,
            actorUserId: actor.userId,
        });

        const sendLoadNumber =
            body.sendLoadNumber !== undefined
                ? bool(body.sendLoadNumber, false)
                : Boolean(customer.sendLoadNumber);
        const toEmail = str(body.customerEmail) || customer.email;
        let loadNumberEmail: { sent: boolean; to?: string; from?: string; error?: string } = {
            sent: false,
        };
        if (sendLoadNumber) {
            loadNumberEmail = await this.sendLoadNumberEmail({
                brokerUserId: brokerId || actor.userId,
                toEmail,
                loadNumber: loaded.loadNumber,
                shipmentLeadId: loaded.shipmentLeadId,
            });
            if (sendLoadNumber !== Boolean(customer.sendLoadNumber)) {
                await prisma.directCustomer
                    .update({
                        where: { customerId: customer.customerId },
                        data: { sendLoadNumber },
                    })
                    .catch(() => undefined);
            }
        }

        const agreementType =
            normalizeCustomerAgreementType(body.agreementType) ||
            (bool(body.sendAgreement, false)
                ? normalizeCustomerAgreementType(customer.agreementType)
                : null);
        let agreementEmail: {
            sent: boolean;
            to?: string;
            from?: string;
            error?: string;
            label?: string;
            signUrl?: string;
        } = { sent: false };
        if (agreementType) {
            if (!toEmail) {
                throw Object.assign(
                    new Error("Customer email is required to send the selected customer agreement"),
                    { status: 422, code: "CUSTOMER_AGREEMENT_EMAIL_REQUIRED" }
                );
            }
            agreementEmail = await this.sendCustomerAgreementEmail({
                brokerUserId: brokerId || actor.userId,
                toEmail,
                companyName: customerName || customer.companyName,
                agreementType,
                customerId: customer.customerId,
                contactName: customer.contactName,
                phone: str(body.customerPhone) || customer.phone,
                billingAddress: customer.billingAddress,
                city: customer.city,
                state: customer.state,
                zip: customer.zip,
            });
            if (agreementType !== customer.agreementType) {
                await prisma.directCustomer
                    .update({
                        where: { customerId: customer.customerId },
                        data: { agreementType },
                    })
                    .catch(() => undefined);
            }
        }

        return {
            customer,
            shipmentLeadId: loaded.shipmentLeadId,
            loadNumber: loaded.loadNumber,
            greenOsShipmentId: loaded.greenOsShipmentId || greenOsShipmentId,
            status: loaded.status,
            loadNumberEmail,
            agreementEmail,
        };
    }

    /**
     * After uShip / Booking Confirmation Create Load customer step:
     * optionally email GL# and/or customer agreement (same options as Direct Create Load).
     * Creates/links a DirectCustomer when an agreement email is requested.
     */
    async sendLoadCustomerSetupEmails(
        shipmentLeadId: string,
        body: Record<string, unknown>,
        actor: Actor
    ): Promise<{
        loadNumberEmail: { sent: boolean; to?: string; from?: string; error?: string };
        agreementEmail: {
            sent: boolean;
            to?: string;
            from?: string;
            error?: string;
            label?: string;
            signUrl?: string;
        };
        directCustomerId: string | null;
    }> {
        const shipment = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId },
        });
        if (!shipment) {
            throw Object.assign(new Error("Load not found"), { status: 404 });
        }

        const customerName =
            str(body.customerName) || str(shipment.customerName) || "Customer";
        const customerEmail = str(body.customerEmail) || str(shipment.customerEmail);
        const customerPhone = str(body.customerPhone) || str(shipment.customerPhone);
        const loadNumber = str(shipment.loadNumber);
        const sendLoadNumber = bool(body.sendLoadNumber, false);
        const agreementType =
            normalizeCustomerAgreementType(body.agreementType) ||
            (bool(body.sendAgreement, false)
                ? normalizeCustomerAgreementType("USHIP_ONETIME")
                : null);
        const brokerId = shipment.assignedBrokerId || actor.userId;

        let loadNumberEmail: { sent: boolean; to?: string; from?: string; error?: string } = {
            sent: false,
        };
        if (sendLoadNumber) {
            if (!customerEmail) {
                throw Object.assign(
                    new Error("Customer email is required to send the load number"),
                    { status: 422, code: "CUSTOMER_LOAD_NUMBER_EMAIL_REQUIRED" }
                );
            }
            if (!loadNumber) {
                throw Object.assign(new Error("Load number was not generated"), {
                    status: 422,
                });
            }
            loadNumberEmail = await this.sendLoadNumberEmail({
                brokerUserId: brokerId,
                toEmail: customerEmail,
                loadNumber,
                shipmentLeadId,
            });
        }

        let agreementEmail: {
            sent: boolean;
            to?: string;
            from?: string;
            error?: string;
            label?: string;
            signUrl?: string;
        } = { sent: false };
        let directCustomerId = shipment.directCustomerId || null;

        if (agreementType) {
            if (!customerEmail) {
                throw Object.assign(
                    new Error("Customer email is required to send the selected customer agreement"),
                    { status: 422, code: "CUSTOMER_AGREEMENT_EMAIL_REQUIRED" }
                );
            }
            if (directCustomerId) {
                await prisma.directCustomer
                    .update({
                        where: { customerId: directCustomerId },
                        data: {
                            companyName: customerName,
                            email: customerEmail,
                            phone: customerPhone,
                            agreementType,
                            ...(sendLoadNumber ? { sendLoadNumber: true } : {}),
                        },
                    })
                    .catch(() => undefined);
            } else {
                const created = await prisma.directCustomer.create({
                    data: {
                        companyName: customerName,
                        email: customerEmail,
                        phone: customerPhone,
                        sendLoadNumber,
                        agreementType,
                        createdByUserId: actor.userId,
                    },
                });
                directCustomerId = created.customerId;
                await prisma.shipmentLead.update({
                    where: { shipmentLeadId },
                    data: { directCustomerId },
                });
            }
            agreementEmail = await this.sendCustomerAgreementEmail({
                brokerUserId: brokerId,
                toEmail: customerEmail,
                companyName: customerName,
                agreementType,
                customerId: directCustomerId,
                phone: customerPhone,
            });
        }

        return { loadNumberEmail, agreementEmail, directCustomerId };
    }

    private async sendLoadNumberEmail(input: {
        brokerUserId: string;
        toEmail: string | null;
        loadNumber: string | null | undefined;
        shipmentLeadId: string;
    }): Promise<{ sent: boolean; to?: string; from?: string; error?: string }> {
        const to = str(input.toEmail);
        if (!to) {
            return { sent: false, error: "Customer email is required to send the load number" };
        }
        const loadNumber = str(input.loadNumber);
        if (!loadNumber) {
            return { sent: false, error: "Load number was not generated" };
        }
        try {
            const mail = buildCustomerLoadNumberEmail({ loadNumber });
            const sent = await brokerGmailOAuthService.sendMailAsBroker(input.brokerUserId, {
                to,
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
            });
            await domainEventEngine
                .emit({
                    shipmentLeadId: input.shipmentLeadId,
                    eventType: "CUSTOMER_LOAD_NUMBER_EMAILED",
                    title: "Load number emailed to customer",
                    message: `Load ${loadNumber} sent to ${to} from ${sent.from}`,
                    actorUserId: input.brokerUserId,
                    payload: { to, from: sent.from, loadNumber },
                })
                .catch(() => undefined);
            return { sent: true, to, from: sent.from };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.warn("[customers] send load number email failed:", error);
            return { sent: false, to, error };
        }
    }
}

export const customerService = new CustomerService();

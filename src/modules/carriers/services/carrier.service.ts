import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { platformNotificationService } from "../../shipment/services/platform-notification.service.js";
import { LOAD_DOCS_ROOT } from "../../shipment/services/load-pdf.service.js";
import {
    AGREEMENT_TEMPLATE_TITLE,
    AGREEMENT_TEMPLATE_VERSION,
    DEFAULT_AGREEMENT_BODY,
    DEFAULT_ONBOARDING_EXPIRY_DAYS,
    ONBOARDING_PURPOSE,
    REQUIRED_CARRIER_DOC_TYPES,
    type OnboardingPurpose,
} from "../constants.js";
import { carrierEmailService } from "./carrier-email.service.js";
import { carrierStorageService } from "./carrier-storage.service.js";
import { storeCarrierAgreementPdf } from "./carrier-agreement-pdf.service.js";
import { shipmentService } from "../../shipment/services/shipment.service.js";
import { normalizeStatus } from "../../shipment/shipment.lifecycle.js";

type Actor = { userId?: string; role?: string; ip?: string; userAgent?: string };

const tokenAttempts = new Map<string, { count: number; resetAt: number }>();

function hashToken(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
}

function newRawToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}

function expiryDays(): number {
    const n = parseInt(process.env.CARRIER_ONBOARDING_EXPIRY_DAYS || "", 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_ONBOARDING_EXPIRY_DAYS;
}

function assertRateLimit(key: string, limit = 40, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const row = tokenAttempts.get(key);
    if (!row || row.resetAt < now) {
        tokenAttempts.set(key, { count: 1, resetAt: now + windowMs });
        return;
    }
    row.count += 1;
    if (row.count > limit) {
        throw Object.assign(new Error("Too many requests. Try again later."), { status: 429 });
    }
}

function money(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return "—";
    return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function place(city?: string | null, state?: string | null, zip?: string | null): string {
    return [city, state, zip].filter(Boolean).join(", ") || "—";
}

export class CarrierService {
    async ensureAgreementTemplate() {
        const active = await prisma.carrierAgreementTemplate.findFirst({
            where: { active: true, version: AGREEMENT_TEMPLATE_VERSION },
            orderBy: { createdAt: "desc" },
        });
        if (active) return active;
        await prisma.carrierAgreementTemplate.updateMany({
            where: { active: true },
            data: { active: false },
        });
        return prisma.carrierAgreementTemplate.create({
            data: {
                title: AGREEMENT_TEMPLATE_TITLE,
                version: AGREEMENT_TEMPLATE_VERSION,
                bodyText: DEFAULT_AGREEMENT_BODY,
                active: true,
            },
        });
    }

    async emitEvent(input: {
        carrierId: string;
        sessionId?: string | null;
        shipmentLeadId?: string | null;
        action: string;
        title: string;
        message?: string;
        actorType?: string;
        actorId?: string | null;
        ip?: string;
        userAgent?: string;
        metadata?: Record<string, unknown>;
    }) {
        return prisma.carrierOnboardingEvent.create({
            data: {
                carrierId: input.carrierId,
                sessionId: input.sessionId || null,
                shipmentLeadId: input.shipmentLeadId || null,
                action: input.action,
                title: input.title,
                message: input.message || null,
                actorType: input.actorType || "SYSTEM",
                actorId: input.actorId || null,
                ipAddress: input.ip || null,
                userAgent: input.userAgent || null,
                metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
            },
        });
    }

    private brokerEmail(broker: {
        email?: string | null;
        brokerGmailAccount?: {
            gmailAddress: string;
            isActive?: boolean | null;
            status?: string | null;
        } | null;
    }): { email: string; warning?: string } {
        const acc = broker.brokerGmailAccount;
        const gmail =
            acc &&
            acc.isActive !== false &&
            (acc.status == null || acc.status === "CONNECTED") &&
            acc.gmailAddress
                ? acc.gmailAddress
                : null;
        if (gmail) return { email: gmail };
        if (broker.email) {
            return {
                email: broker.email,
                warning: "Broker Gmail not connected — emailed account email instead",
            };
        }
        const fallback = carrierEmailService.fallbackAdminEmail();
        return {
            email: fallback,
            warning: "Assigned broker has no Gmail/email — notified admin fallback",
        };
    }

    async assertCarrierAccess(carrierId: string, actor: Actor) {
        const carrier = await prisma.carrier.findUnique({ where: { carrierId } });
        if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
        if (actor.role === "Broker" && carrier.assignedBrokerId && carrier.assignedBrokerId !== actor.userId) {
            throw Object.assign(new Error("Access denied"), { status: 403 });
        }
        return carrier;
    }

    async list(actor: Actor, query: { status?: string; q?: string }) {
        const where: Record<string, unknown> = {};
        if (actor.role === "Broker") where.assignedBrokerId = actor.userId;
        if (query.status) where.onboardingStatus = query.status;
        if (query.q) {
            const q = String(query.q).trim();
            where.OR = [
                { legalName: { contains: q } },
                { dbaName: { contains: q } },
                { email: { contains: q } },
                { mcNumber: { contains: q } },
                { dotNumber: { contains: q } },
                { contactName: { contains: q } },
            ];
        }
        const rows = await prisma.carrier.findMany({
            where,
            orderBy: { updatedAt: "desc" },
            include: {
                assignedBroker: { select: { userId: true, firstName: true, lastName: true, email: true } },
            },
            take: 200,
        });
        return rows;
    }

    async dashboard(actor: Actor) {
        const where: Record<string, unknown> = {};
        if (actor.role === "Broker") where.assignedBrokerId = actor.userId;
        const rows = await prisma.carrier.groupBy({
            by: ["onboardingStatus"],
            where,
            _count: { _all: true },
        });
        const counts: Record<string, number> = {};
        for (const r of rows) counts[r.onboardingStatus] = r._count._all;
        return { counts, total: rows.reduce((a, b) => a + b._count._all, 0) };
    }

    async get(carrierId: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const carrier = await prisma.carrier.findUnique({
            where: { carrierId },
            include: {
                assignedBroker: {
                    select: {
                        userId: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        brokerGmailAccount: { select: { gmailAddress: true, isActive: true } },
                    },
                },
                documents: { orderBy: [{ documentType: "asc" }, { version: "desc" }] },
                agreementSigns: {
                    orderBy: { signedAt: "desc" },
                    include: { template: true },
                },
                rcSignatures: { orderBy: { signedAt: "desc" } },
                events: { orderBy: { createdAt: "desc" }, take: 100 },
                sessions: { orderBy: { createdAt: "desc" }, take: 10 },
            },
        });
        if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
        const template = await this.ensureAgreementTemplate();
        return { ...carrier, activeAgreementTemplate: template };
    }

    async createAndInvite(
        body: Record<string, unknown>,
        actor: Actor
    ): Promise<{ carrier: unknown; inviteSent: boolean; warning?: string }> {
        const legalName = String(body.legalName || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        if (!legalName) throw Object.assign(new Error("Company Legal Name is required"), { status: 400 });
        if (!email || !email.includes("@")) {
            throw Object.assign(new Error("Valid Carrier Email is required"), { status: 400 });
        }

        const assignedBrokerId =
            actor.role === "Broker"
                ? actor.userId
                : String(body.assignedBrokerId || actor.userId || "") || null;

        const shipmentLeadId = body.shipmentLeadId ? String(body.shipmentLeadId) : null;
        if (shipmentLeadId) {
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId },
                select: { shipmentLeadId: true, assignedBrokerId: true },
            });
            if (!lead) throw Object.assign(new Error("Shipment not found"), { status: 404 });
            if (actor.role === "Broker" && lead.assignedBrokerId !== actor.userId) {
                throw Object.assign(new Error("Shipment access denied"), { status: 403 });
            }
        }

        const carrier = await prisma.carrier.create({
            data: {
                legalName,
                dbaName: body.dbaName ? String(body.dbaName).trim() : null,
                email,
                phone: body.phone ? String(body.phone).trim() : null,
                mcNumber: body.mcNumber ? String(body.mcNumber).trim() : null,
                dotNumber: body.dotNumber ? String(body.dotNumber).trim() : null,
                address: body.address ? String(body.address).trim() : null,
                city: body.city ? String(body.city).trim() : null,
                state: body.state ? String(body.state).trim().toUpperCase() : null,
                zip: body.zip ? String(body.zip).trim() : null,
                contactName: body.contactName ? String(body.contactName).trim() : null,
                assignedBrokerId,
                status: "ACTIVE",
                onboardingStatus: "INVITED",
            },
        });

        if (shipmentLeadId) {
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: {
                    carrierProfileId: carrier.carrierId,
                    carrierName: carrier.legalName,
                    carrierEmail: carrier.email,
                    carrierPhone: carrier.phone,
                    carrierMc: carrier.mcNumber,
                    carrierDot: carrier.dotNumber,
                },
            });
        }

        await this.emitEvent({
            carrierId: carrier.carrierId,
            action: "CARRIER_CREATED",
            title: "Carrier created",
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
            shipmentLeadId,
        });

        const invite = await this.createSessionAndSendInvite(carrier.carrierId, {
            ...actor,
            shipmentLeadId,
            purpose: ONBOARDING_PURPOSE.AGREEMENT_PACKET,
        }).catch((err) => {
            return {
                sent: false,
                warning: err instanceof Error ? err.message : "Invite email failed",
                session: null,
                onboardingUrl: "",
                purpose: ONBOARDING_PURPOSE.AGREEMENT_PACKET,
                sentVia: "none",
            };
        });

        return { carrier, inviteSent: invite.sent, warning: invite.warning };
    }

    /**
     * Step 1 — after Assign Carrier: create/link Carrier + email agreement packet
     * FROM broker Gmail TO carrier Gmail.
     */
    async inviteAgreementFromLoad(shipmentLeadId: string, actor: Actor) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) throw Object.assign(new Error("Load not found"), { status: 404 });
        if (actor.role === "Broker" && lead.assignedBrokerId && lead.assignedBrokerId !== actor.userId) {
            throw Object.assign(new Error("Access denied"), { status: 403 });
        }
        const email = String(lead.carrierEmail || "").trim().toLowerCase();
        const legalName = String(lead.carrierName || "").trim();
        if (!legalName) {
            throw Object.assign(new Error("Carrier name is required before sending onboarding"), {
                status: 400,
            });
        }
        if (!email || !email.includes("@")) {
            throw Object.assign(new Error("Carrier email is required before sending onboarding"), {
                status: 400,
            });
        }
        const brokerId = actor.role === "Broker" ? actor.userId : lead.assignedBrokerId || actor.userId;
        if (!brokerId) {
            throw Object.assign(new Error("Assigned broker is required"), { status: 400 });
        }

        let carrier =
            (lead.carrierProfileId
                ? await prisma.carrier.findUnique({ where: { carrierId: lead.carrierProfileId } })
                : null) ||
            (await prisma.carrier.findFirst({
                where: { email, assignedBrokerId: brokerId },
                orderBy: { updatedAt: "desc" },
            }));

        if (!carrier) {
            carrier = await prisma.carrier.create({
                data: {
                    legalName,
                    email,
                    phone: lead.carrierPhone,
                    mcNumber: lead.carrierMc,
                    dotNumber: lead.carrierDot,
                    contactName: lead.driverName || legalName,
                    assignedBrokerId: brokerId,
                    onboardingStatus: "INVITED",
                    status: "ACTIVE",
                },
            });
            await this.emitEvent({
                carrierId: carrier.carrierId,
                shipmentLeadId,
                action: "CARRIER_CREATED",
                title: "Carrier created from Assign Carrier",
                actorType: "BROKER",
                actorId: actor.userId,
                ip: actor.ip,
                userAgent: actor.userAgent,
            });
        } else {
            carrier = await prisma.carrier.update({
                where: { carrierId: carrier.carrierId },
                data: {
                    legalName,
                    email,
                    phone: lead.carrierPhone || carrier.phone,
                    mcNumber: lead.carrierMc || carrier.mcNumber,
                    dotNumber: lead.carrierDot || carrier.dotNumber,
                    assignedBrokerId: brokerId,
                },
            });
        }

        await prisma.shipmentLead.update({
            where: { shipmentLeadId },
            data: { carrierProfileId: carrier.carrierId },
        });

        if (String(carrier.onboardingStatus || "").toUpperCase() === "APPROVED") {
            return {
                carrier,
                invite: {
                    sent: false,
                    skipped: true,
                    reason: "already_registered",
                    warning: null,
                    session: null,
                    onboardingUrl: "",
                    purpose: ONBOARDING_PURPOSE.AGREEMENT_PACKET,
                    sentVia: "none",
                },
            };
        }

        const invite = await this.createSessionAndSendInvite(carrier.carrierId, {
            ...actor,
            shipmentLeadId,
            purpose: ONBOARDING_PURPOSE.AGREEMENT_PACKET,
        });
        return { carrier, invite };
    }

    /**
     * Step 2 — after BOL Save: email RC+BOL review link FROM broker Gmail.
     */
    async inviteRcBolFromLoad(shipmentLeadId: string, actor: Actor) {
        const lead = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!lead) throw Object.assign(new Error("Load not found"), { status: 404 });
        if (actor.role === "Broker" && lead.assignedBrokerId && lead.assignedBrokerId !== actor.userId) {
            throw Object.assign(new Error("Access denied"), { status: 403 });
        }
        if (!lead.carrierProfileId) {
            const email = String(lead.carrierEmail || "").trim().toLowerCase();
            const legalName = String(lead.carrierName || "").trim();
            if (!legalName || !email) {
                throw Object.assign(
                    new Error("Carrier name and email are required on the load before RC/BOL link"),
                    { status: 400 }
                );
            }
            const brokerId =
                actor.role === "Broker" ? actor.userId : lead.assignedBrokerId || actor.userId;
            const created = await prisma.carrier.create({
                data: {
                    legalName,
                    email,
                    phone: lead.carrierPhone,
                    mcNumber: lead.carrierMc,
                    dotNumber: lead.carrierDot,
                    assignedBrokerId: brokerId || null,
                    onboardingStatus: "IN_PROGRESS",
                },
            });
            await prisma.shipmentLead.update({
                where: { shipmentLeadId },
                data: { carrierProfileId: created.carrierId },
            });
        }
        const refreshed = await prisma.shipmentLead.findUnique({ where: { shipmentLeadId } });
        if (!refreshed?.carrierProfileId) {
            throw Object.assign(new Error("Carrier profile missing on load"), { status: 400 });
        }
        const bol = await prisma.loadDocument.findFirst({
            where: { shipmentLeadId, docType: "BOL", isCurrent: true },
        });
        if (!bol) {
            throw Object.assign(new Error("Save BOL first, then the RC/BOL link can be sent"), {
                status: 400,
            });
        }
        const invite = await this.createSessionAndSendInvite(refreshed.carrierProfileId, {
            ...actor,
            shipmentLeadId,
            purpose: ONBOARDING_PURPOSE.RC_BOL_PACKET,
        });
        return { invite, carrierId: refreshed.carrierProfileId };
    }

    async createSessionAndSendInvite(
        carrierId: string,
        actor: Actor & {
            shipmentLeadId?: string | null;
            reason?: string;
            purpose?: OnboardingPurpose;
        }
    ) {
        const purpose = actor.purpose || ONBOARDING_PURPOSE.AGREEMENT_PACKET;
        const carrier = await prisma.carrier.findUnique({
            where: { carrierId },
            include: {
                assignedBroker: {
                    select: {
                        userId: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        brokerGmailAccount: { select: { gmailAddress: true, isActive: true, status: true, refreshToken: true } },
                    },
                },
            },
        });
        if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
        if (!carrier.assignedBrokerId) {
            throw Object.assign(new Error("Carrier has no assigned broker"), { status: 400 });
        }

        await prisma.carrierOnboardingSession.updateMany({
            where: { carrierId, status: "ACTIVE", purpose },
            data: { status: "REVOKED" },
        });

        const raw = newRawToken();
        const tokenHash = hashToken(raw);
        const expiresAt = new Date(Date.now() + expiryDays() * 24 * 60 * 60 * 1000);
        const session = await prisma.carrierOnboardingSession.create({
            data: {
                carrierId,
                tokenHash,
                expiresAt,
                status: "ACTIVE",
                purpose,
                createdById: actor.userId || null,
                shipmentLeadId: actor.shipmentLeadId || null,
                changeRequestNote: actor.reason || null,
            },
        });

        const url = carrierEmailService.carrierPortalUrl(raw);
        const brokerName = carrier.assignedBroker
            ? `${carrier.assignedBroker.firstName} ${carrier.assignedBroker.lastName}`.trim()
            : undefined;

        let loadNumber: string | null = null;
        if (session.shipmentLeadId) {
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: session.shipmentLeadId },
                select: { loadNumber: true, greenOsShipmentId: true },
            });
            loadNumber = lead?.loadNumber || lead?.greenOsShipmentId || null;
        }

        let warning: string | undefined;
        let sentVia = "broker-gmail";
        try {
            const mail =
                purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET
                    ? await carrierEmailService.sendRcBolInvite({
                          brokerUserId: carrier.assignedBrokerId,
                          to: carrier.email,
                          contactName: carrier.contactName || "",
                          carrierLegalName: carrier.legalName,
                          onboardingUrl: url,
                          brokerName,
                          loadNumber,
                      })
                    : await carrierEmailService.sendAgreementInvite({
                          brokerUserId: carrier.assignedBrokerId,
                          to: carrier.email,
                          contactName: carrier.contactName || "",
                          carrierLegalName: carrier.legalName,
                          onboardingUrl: url,
                          brokerName,
                          loadNumber,
                      });
            sentVia = mail.via;
        } catch (err) {
            warning = err instanceof Error ? err.message : "Failed to send invite email";
            throw Object.assign(new Error(warning), {
                status: (err as { status?: number })?.status || 400,
                code: (err as { code?: string })?.code,
                sessionId: session.sessionId,
            });
        }

        await prisma.carrier.update({
            where: { carrierId },
            data: {
                onboardingStatus:
                    carrier.onboardingStatus === "REQUEST_CHANGES" ||
                    purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET
                        ? carrier.onboardingStatus === "APPROVED"
                            ? "APPROVED"
                            : carrier.onboardingStatus === "SUBMITTED"
                              ? "IN_PROGRESS"
                              : "INVITED"
                        : "INVITED",
            },
        });

        await this.emitEvent({
            carrierId,
            sessionId: session.sessionId,
            shipmentLeadId: session.shipmentLeadId,
            action:
                purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET
                    ? "RC_BOL_INVITATION_SENT"
                    : "INVITATION_SENT",
            title:
                purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET
                    ? "RC/BOL invitation sent from broker Gmail"
                    : "Agreement invitation sent from broker Gmail",
            message: `Emailed ${carrier.email} via ${sentVia}`,
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: { purpose, sentVia },
        });

        return { session, sent: true, warning, onboardingUrl: url, purpose, sentVia };
    }

    async resendInvite(carrierId: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        return this.createSessionAndSendInvite(carrierId, actor);
    }

    async requestChanges(carrierId: string, reason: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        if (!String(reason || "").trim()) {
            throw Object.assign(new Error("Change request reason is required"), { status: 400 });
        }
        await prisma.carrier.update({
            where: { carrierId },
            data: { onboardingStatus: "REQUEST_CHANGES" },
        });
        await this.emitEvent({
            carrierId,
            action: "CORRECTION_REQUESTED",
            title: "Correction requested",
            message: reason,
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
        });
        const invite = await this.createSessionAndSendInvite(carrierId, { ...actor, reason });
        const carrier = await prisma.carrier.findUnique({ where: { carrierId } });
        if (carrier?.email && invite.onboardingUrl) {
            try {
                await carrierEmailService.sendChangeRequest({
                    to: carrier.email,
                    contactName: carrier.contactName || "",
                    carrierLegalName: carrier.legalName,
                    reason,
                    onboardingUrl: invite.onboardingUrl,
                    brokerUserId: carrier.assignedBrokerId,
                });
            } catch {
                /* invite already sent */
            }
        }
        return invite;
    }

    async approve(carrierId: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const carrier = await prisma.carrier.update({
            where: { carrierId },
            data: { onboardingStatus: "APPROVED", status: "ACTIVE" },
        });
        await prisma.shipmentLead.updateMany({
            where: { carrierProfileId: carrierId },
            data: { carrierStatus: "Approved" },
        });
        await this.emitEvent({
            carrierId,
            action: "CARRIER_APPROVED",
            title: "Carrier approved",
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
        });
        return carrier;
    }

    async reject(carrierId: string, reason: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const carrier = await prisma.carrier.update({
            where: { carrierId },
            data: { onboardingStatus: "REJECTED" },
        });
        await this.emitEvent({
            carrierId,
            action: "CARRIER_REJECTED",
            title: "Carrier rejected",
            message: reason || undefined,
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
        });
        return carrier;
    }

    async patch(carrierId: string, body: Record<string, unknown>, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const data: Record<string, unknown> = {};
        const str = (k: string, field: string) => {
            if (body[k] !== undefined) data[field] = body[k] == null || body[k] === "" ? null : String(body[k]).trim();
        };
        str("legalName", "legalName");
        str("dbaName", "dbaName");
        str("email", "email");
        str("phone", "phone");
        str("mcNumber", "mcNumber");
        str("dotNumber", "dotNumber");
        str("address", "address");
        str("city", "city");
        str("state", "state");
        str("zip", "zip");
        str("contactName", "contactName");
        str("notes", "notes");
        str("status", "status");
        if (body.assignedBrokerId !== undefined && actor.role !== "Broker") {
            data.assignedBrokerId = body.assignedBrokerId ? String(body.assignedBrokerId) : null;
        }
        const carrier = await prisma.carrier.update({ where: { carrierId }, data });
        await this.emitEvent({
            carrierId,
            action: "CARRIER_UPDATED",
            title: "Carrier information updated",
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
        });
        return carrier;
    }

    // ——— Public token portal ———

    private async resolveSession(rawToken: string, ip?: string) {
        assertRateLimit(`tok:${ip || "x"}:${rawToken.slice(0, 8)}`);
        const tokenHash = hashToken(rawToken);
        const session = await prisma.carrierOnboardingSession.findUnique({
            where: { tokenHash },
            include: { carrier: true },
        });
        if (!session) {
            throw Object.assign(new Error("Invalid onboarding link."), { status: 404, code: "INVALID" });
        }
        if (session.status === "REVOKED") {
            throw Object.assign(new Error("This onboarding link is no longer valid."), {
                status: 410,
                code: "REVOKED",
            });
        }
        if (session.status === "SUBMITTED" || session.submittedAt) {
            throw Object.assign(new Error("This onboarding package has already been submitted."), {
                status: 409,
                code: "SUBMITTED",
            });
        }
        if (session.status === "EXPIRED" || session.expiresAt.getTime() < Date.now()) {
            if (session.status !== "EXPIRED") {
                await prisma.carrierOnboardingSession.update({
                    where: { sessionId: session.sessionId },
                    data: { status: "EXPIRED" },
                });
                await prisma.carrier.update({
                    where: { carrierId: session.carrierId },
                    data: { onboardingStatus: "EXPIRED" },
                });
            }
            throw Object.assign(
                new Error(
                    "This onboarding link has expired. Please contact your Green Logistics representative."
                ),
                { status: 410, code: "EXPIRED" }
            );
        }
        return session;
    }

    async publicGet(rawToken: string, meta: { ip?: string; userAgent?: string }) {
        const session = await this.resolveSession(rawToken, meta.ip);
        const firstOpen = !session.openedAt;
        if (firstOpen) {
            await prisma.carrierOnboardingSession.update({
                where: { sessionId: session.sessionId },
                data: { openedAt: new Date() },
            });
            if (session.carrier.onboardingStatus === "INVITED") {
                await prisma.carrier.update({
                    where: { carrierId: session.carrierId },
                    data: { onboardingStatus: "OPENED" },
                });
            }
            await this.emitEvent({
                carrierId: session.carrierId,
                sessionId: session.sessionId,
                action: "INVITATION_OPENED",
                title: "Carrier opened onboarding link",
                actorType: "CARRIER",
                ip: meta.ip,
                userAgent: meta.userAgent,
            });
            if (session.carrier.assignedBrokerId) {
                await platformNotificationService.notifyUser({
                    userId: session.carrier.assignedBrokerId,
                    notificationType: "CARRIER_ONBOARDING_OPENED",
                    title: "Carrier opened onboarding",
                    message: `${session.carrier.legalName} opened the onboarding link.`,
                    meta: { carrierId: session.carrierId },
                });
            }
        }

        const template = await this.ensureAgreementTemplate();
        const documents = await prisma.carrierDocument.findMany({
            where: { carrierId: session.carrierId, status: "CURRENT" },
            orderBy: { uploadedAt: "desc" },
        });
        const agreement = await prisma.carrierAgreementSignature.findFirst({
            where: { carrierId: session.carrierId, sessionId: session.sessionId },
            orderBy: { signedAt: "desc" },
        });
        const rc = await prisma.carrierRcSignature.findFirst({
            where: { carrierId: session.carrierId, sessionId: session.sessionId },
            orderBy: { signedAt: "desc" },
        });

        let rcDraft: Record<string, unknown> | null = null;
        let shipment: Record<string, unknown> | null = null;
        if (session.shipmentLeadId) {
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: session.shipmentLeadId },
            });
            if (lead) {
                shipment = {
                    shipmentLeadId: lead.shipmentLeadId,
                    greenOsShipmentId: lead.greenOsShipmentId,
                    loadNumber: lead.loadNumber,
                    shipmentTitle: lead.shipmentTitle,
                    pickup: place(lead.pickupCity, lead.pickupState, lead.pickupZip),
                    delivery: place(lead.deliveryCity, lead.deliveryState, lead.deliveryZip),
                    equipment: lead.equipment,
                    vehicle: lead.vehicle,
                    weight: lead.weight,
                    commodity: lead.commodity,
                    agreedRate: lead.carrierRate ?? lead.price,
                    agreedRateLabel: money(lead.carrierRate ?? lead.price),
                    pickupFrom: lead.pickupFrom,
                    deliveryFrom: lead.deliveryFrom,
                    specialInstructions: lead.specialInstructions,
                };
                rcDraft = {
                    shipmentReference: lead.greenOsShipmentId || lead.loadNumber || lead.shipmentTitle,
                    pickup: place(lead.pickupCity, lead.pickupState, lead.pickupZip),
                    delivery: place(lead.deliveryCity, lead.deliveryState, lead.deliveryZip),
                    vehicleCargo: [lead.equipment, lead.vehicle, lead.commodity, lead.weight]
                        .filter(Boolean)
                        .join(" · "),
                    agreedRate: lead.carrierRate ?? lead.price,
                    agreedRateLabel: money(lead.carrierRate ?? lead.price),
                    carrierName: session.carrier.legalName,
                    carrierMc: session.carrier.mcNumber,
                    carrierDot: session.carrier.dotNumber,
                    brokerName: "Green Logistics LLC",
                    date: new Date().toISOString().slice(0, 10),
                    additionalTerms: lead.specialInstructions || "",
                };
            }
        }

        let progress: Record<string, unknown> = {};
        try {
            progress = session.progressJson ? JSON.parse(session.progressJson) : {};
        } catch {
            progress = {};
        }

        const purpose = session.purpose || ONBOARDING_PURPOSE.AGREEMENT_PACKET;
        let rateConDoc: Record<string, unknown> | null = null;
        let bolDoc: Record<string, unknown> | null = null;
        if (purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET && session.shipmentLeadId) {
            const [rcRow, bolRow] = await Promise.all([
                prisma.loadDocument.findFirst({
                    where: {
                        shipmentLeadId: session.shipmentLeadId,
                        docType: "RATE_CONFIRMATION",
                        isCurrent: true,
                    },
                }),
                prisma.loadDocument.findFirst({
                    where: {
                        shipmentLeadId: session.shipmentLeadId,
                        docType: "BOL",
                        isCurrent: true,
                    },
                }),
            ]);
            const parse = (raw: string | null | undefined) => {
                if (!raw) return {};
                try {
                    return JSON.parse(raw);
                } catch {
                    return {};
                }
            };
            if (rcRow) {
                rateConDoc = {
                    documentId: rcRow.documentId,
                    title: rcRow.title,
                    version: rcRow.version,
                    fileName: rcRow.fileName,
                    hasPdf: Boolean(rcRow.storedName),
                    content: parse(rcRow.contentJson),
                };
            }
            if (bolRow) {
                bolDoc = {
                    documentId: bolRow.documentId,
                    title: bolRow.title,
                    version: bolRow.version,
                    fileName: bolRow.fileName,
                    hasPdf: Boolean(bolRow.storedName),
                    content: parse(bolRow.contentJson),
                };
            }
        }

        const requireDocs = purpose === ONBOARDING_PURPOSE.AGREEMENT_PACKET;
        const requireAgreement = purpose === ONBOARDING_PURPOSE.AGREEMENT_PACKET;
        const requireRc =
            purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET
                ? true
                : Boolean(session.shipmentLeadId) && purpose !== ONBOARDING_PURPOSE.AGREEMENT_PACKET;

        return {
            session: {
                sessionId: session.sessionId,
                expiresAt: session.expiresAt,
                shipmentLeadId: session.shipmentLeadId,
                changeRequestNote: session.changeRequestNote,
                purpose,
                requireRc: purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET || Boolean(session.shipmentLeadId && purpose !== ONBOARDING_PURPOSE.AGREEMENT_PACKET),
                requireAgreement,
                requireDocs,
            },
            carrier: session.carrier,
            agreementTemplate: {
                templateId: template.templateId,
                title: template.title,
                version: template.version,
                bodyText: template.bodyText,
            },
            documents: documents.map((d) => ({
                documentId: d.documentId,
                documentType: d.documentType,
                originalFilename: d.originalFilename,
                mimeType: d.mimeType,
                fileSize: d.fileSize,
                version: d.version,
                uploadedAt: d.uploadedAt,
            })),
            agreementSigned: Boolean(agreement),
            agreementSignature: agreement
                ? {
                      signerName: agreement.signerName,
                      signedAt: agreement.signedAt,
                  }
                : null,
            rcSigned: Boolean(rc),
            rcDraft,
            rateConDoc,
            bolDoc,
            shipment,
            progress,
            checklist: this.buildChecklist({
                carrier: session.carrier,
                documents,
                agreementSigned: Boolean(agreement),
                rcSigned: Boolean(rc),
                requireRc: purpose === ONBOARDING_PURPOSE.RC_BOL_PACKET,
                requireAgreement,
                requireDocs,
            }),
        };
    }

    buildChecklist(input: {
        carrier: {
            legalName: string;
            email: string;
            phone: string | null;
            mcNumber: string | null;
            dotNumber: string | null;
            contactName: string | null;
            address: string | null;
            city: string | null;
            state: string | null;
            zip: string | null;
        };
        documents: Array<{ documentType: string; status: string }>;
        agreementSigned: boolean;
        rcSigned: boolean;
        requireRc: boolean;
        requireAgreement?: boolean;
        requireDocs?: boolean;
    }) {
        const requireAgreement = input.requireAgreement !== false;
        const requireDocs = input.requireDocs !== false;
        const companyOk = Boolean(
            input.carrier.legalName &&
                input.carrier.email &&
                input.carrier.contactName &&
                input.carrier.phone &&
                input.carrier.mcNumber &&
                input.carrier.dotNumber &&
                input.carrier.address &&
                input.carrier.city &&
                input.carrier.state &&
                input.carrier.zip
        );
        const currentTypes = new Set(
            input.documents.filter((d) => d.status === "CURRENT").map((d) => d.documentType)
        );
        const docs = REQUIRED_CARRIER_DOC_TYPES.map((t) => ({
            type: t,
            ok: currentTypes.has(t),
        }));
        const missing: string[] = [];
        if (requireDocs || requireAgreement) {
            if (!companyOk) missing.push("Company Information");
        }
        if (requireAgreement && !input.agreementSigned) {
            missing.push("Carrier-Broker Agreement signature");
        }
        if (input.requireRc && !input.rcSigned) missing.push("Rate Confirmation / BOL signature");
        if (requireDocs) {
            for (const d of docs) {
                if (!d.ok) {
                    if (d.type === "MC_AUTHORITY") missing.push("MC Authority");
                    else if (d.type === "NOA") missing.push("NOA");
                    else if (d.type === "W9") missing.push("W-9");
                }
            }
        }
        return {
            companyInformation: !requireDocs && !requireAgreement ? true : companyOk,
            agreement: requireAgreement ? input.agreementSigned : true,
            rc: input.requireRc ? input.rcSigned : true,
            rcRequired: input.requireRc,
            documents: requireDocs ? docs : docs.map((d) => ({ ...d, ok: true })),
            missing,
            ready: missing.length === 0,
        };
    }

    async publicSave(rawToken: string, body: Record<string, unknown>, meta: { ip?: string; userAgent?: string }) {
        const session = await this.resolveSession(rawToken, meta.ip);
        const data: Record<string, unknown> = {};
        const map: Array<[string, string]> = [
            ["legalName", "legalName"],
            ["dbaName", "dbaName"],
            ["contactName", "contactName"],
            ["email", "email"],
            ["phone", "phone"],
            ["fax", "fax"],
            ["federalTaxId", "federalTaxId"],
            ["mcNumber", "mcNumber"],
            ["dotNumber", "dotNumber"],
            ["address", "address"],
            ["city", "city"],
            ["state", "state"],
            ["zip", "zip"],
            ["equipmentNotes", "equipmentNotes"],
            ["paymentOption", "paymentOption"],
        ];
        for (const [from, to] of map) {
            if (body[from] !== undefined) {
                let v = body[from] == null || body[from] === "" ? null : String(body[from]).trim();
                if (to === "email" && v) v = v.toLowerCase();
                if (to === "state" && v) v = v.toUpperCase();
                data[to] = v;
            }
        }
        if (data.email && !String(data.email).includes("@")) {
            throw Object.assign(new Error("Valid email is required"), { status: 400 });
        }

        const progressJson =
            body.progress != null ? JSON.stringify(body.progress) : session.progressJson;

        const carrier = await prisma.carrier.update({
            where: { carrierId: session.carrierId },
            data,
        });
        await prisma.carrierOnboardingSession.update({
            where: { sessionId: session.sessionId },
            data: { progressJson: progressJson || null },
        });
        if (["INVITED", "OPENED"].includes(carrier.onboardingStatus)) {
            await prisma.carrier.update({
                where: { carrierId: session.carrierId },
                data: { onboardingStatus: "IN_PROGRESS" },
            });
        }
        await this.emitEvent({
            carrierId: session.carrierId,
            sessionId: session.sessionId,
            action: "COMPANY_INFO_UPDATED",
            title: "Company information updated",
            actorType: "CARRIER",
            ip: meta.ip,
            userAgent: meta.userAgent,
        });
        return { carrier, saved: true };
    }

    async publicSignAgreement(
        rawToken: string,
        body: Record<string, unknown>,
        meta: { ip?: string; userAgent?: string }
    ) {
        const session = await this.resolveSession(rawToken, meta.ip);
        const signerName = String(body.signerName || "").trim();
        const signatureData = String(body.signatureData || "").trim();
        const agreed = body.agreed === true || body.agreed === "true" || body.agreed === 1;
        if (!signerName) throw Object.assign(new Error("Full Legal Name is required"), { status: 400 });
        if (!signatureData) throw Object.assign(new Error("Signature is required"), { status: 400 });
        if (!agreed) {
            throw Object.assign(new Error("You must agree to the Carrier-Broker Agreement"), {
                status: 400,
            });
        }
        const template = await this.ensureAgreementTemplate();
        const documentHash = crypto.createHash("sha256").update(template.bodyText).digest("hex");
        const row = await prisma.carrierAgreementSignature.create({
            data: {
                carrierId: session.carrierId,
                templateId: template.templateId,
                sessionId: session.sessionId,
                signerName,
                signerEmail: session.carrier.email,
                signatureData,
                agreed: true,
                ipAddress: meta.ip || null,
                userAgent: meta.userAgent || null,
                documentHash,
            },
        });

        let pdfDocumentId: string | null = null;
        try {
            pdfDocumentId = await this.archiveSignedAgreementPdf({
                carrierId: session.carrierId,
                signature: row,
                template,
                carrier: session.carrier,
            });
        } catch (err) {
            await this.emitEvent({
                carrierId: session.carrierId,
                sessionId: session.sessionId,
                action: "AGREEMENT_PDF_FAILED",
                title: "Agreement PDF generation failed",
                message: err instanceof Error ? err.message : "PDF failed",
                actorType: "SYSTEM",
            });
        }

        await this.emitEvent({
            carrierId: session.carrierId,
            sessionId: session.sessionId,
            action: "AGREEMENT_SIGNED",
            title: "Agreement signed",
            message: `Signed by ${signerName} (template ${template.version})${
                pdfDocumentId ? " · PDF archived" : ""
            }`,
            actorType: "CARRIER",
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { templateId: template.templateId, documentHash, pdfDocumentId },
        });
        if (["INVITED", "OPENED"].includes(session.carrier.onboardingStatus)) {
            await prisma.carrier.update({
                where: { carrierId: session.carrierId },
                data: { onboardingStatus: "IN_PROGRESS" },
            });
        }
        return { ...row, pdfDocumentId };
    }

    /** Create versioned signed Agreement PDF under Carrier Documents. */
    async archiveSignedAgreementPdf(input: {
        carrierId: string;
        signature: {
            signatureId: string;
            signerName: string;
            signerEmail: string;
            signatureData: string;
            signedAt: Date;
            ipAddress: string | null;
            documentHash: string | null;
        };
        template: { title: string; version: string; bodyText: string };
        carrier: {
            legalName: string;
            dbaName: string | null;
            contactName: string | null;
            email: string;
            phone: string | null;
            fax?: string | null;
            federalTaxId?: string | null;
            mcNumber: string | null;
            dotNumber: string | null;
            address: string | null;
            city: string | null;
            state: string | null;
            zip: string | null;
            equipmentNotes?: string | null;
            paymentOption?: string | null;
        };
    }) {
        const prev = await prisma.carrierDocument.findFirst({
            where: {
                carrierId: input.carrierId,
                documentType: "BROKER_CARRIER_AGREEMENT",
                status: "CURRENT",
            },
            orderBy: { version: "desc" },
        });
        const version = (prev?.version || 0) + 1;
        if (prev) {
            await prisma.carrierDocument.update({
                where: { documentId: prev.documentId },
                data: { status: "ARCHIVED" },
            });
        }

        const stored = await storeCarrierAgreementPdf({
            carrierId: input.carrierId,
            version,
            legalName: input.carrier.legalName,
            dbaName: input.carrier.dbaName,
            contactName: input.carrier.contactName,
            email: input.carrier.email,
            phone: input.carrier.phone,
            fax: input.carrier.fax,
            federalTaxId: input.carrier.federalTaxId,
            mcNumber: input.carrier.mcNumber,
            dotNumber: input.carrier.dotNumber,
            address: input.carrier.address,
            city: input.carrier.city,
            state: input.carrier.state,
            zip: input.carrier.zip,
            equipmentNotes: input.carrier.equipmentNotes,
            paymentOption: input.carrier.paymentOption,
            agreementTitle: input.template.title,
            agreementVersion: input.template.version,
            agreementBody: input.template.bodyText,
            signerName: input.signature.signerName,
            signerEmail: input.signature.signerEmail,
            signatureDataUrl: input.signature.signatureData,
            signedAt: input.signature.signedAt,
            ipAddress: input.signature.ipAddress,
            documentHash: input.signature.documentHash,
        });

        const doc = await prisma.carrierDocument.create({
            data: {
                carrierId: input.carrierId,
                documentType: "BROKER_CARRIER_AGREEMENT",
                originalFilename: `Broker-Carrier-Agreement_v${input.template.version}_${input.carrier.legalName.replace(
                    /[^\w.\- ]+/g,
                    ""
                ).slice(0, 40)}.pdf`,
                storageKey: stored.storageKey,
                mimeType: "application/pdf",
                fileSize: stored.fileSize,
                checksum: stored.checksum,
                uploadedBy: "SYSTEM",
                status: "CURRENT",
                version,
            },
        });
        return doc.documentId;
    }

    /** Backfill signed Agreement PDF for carriers that signed before PDF generation existed. */
    async regenerateAgreementPdf(carrierId: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const carrier = await prisma.carrier.findUnique({ where: { carrierId } });
        if (!carrier) throw Object.assign(new Error("Carrier not found"), { status: 404 });
        const signature = await prisma.carrierAgreementSignature.findFirst({
            where: { carrierId },
            orderBy: { signedAt: "desc" },
            include: { template: true },
        });
        if (!signature) {
            throw Object.assign(new Error("No agreement signature on file"), { status: 400 });
        }
        const template = signature.template || (await this.ensureAgreementTemplate());
        const pdfDocumentId = await this.archiveSignedAgreementPdf({
            carrierId,
            signature,
            template,
            carrier,
        });
        await this.emitEvent({
            carrierId,
            action: "AGREEMENT_PDF_GENERATED",
            title: "Agreement PDF generated",
            message: `PDF document ${pdfDocumentId}`,
            actorType: "BROKER",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
        });
        return { pdfDocumentId };
    }

    async publicSignRc(
        rawToken: string,
        body: Record<string, unknown>,
        meta: { ip?: string; userAgent?: string }
    ) {
        const session = await this.resolveSession(rawToken, meta.ip);
        if (!session.shipmentLeadId) {
            throw Object.assign(new Error("No Rate Confirmation is linked to this onboarding."), {
                status: 400,
            });
        }
        const signerName = String(body.signerName || "").trim();
        const signatureData = String(body.signatureData || "").trim();
        if (!signerName || !signatureData) {
            throw Object.assign(new Error("Name and signature are required"), { status: 400 });
        }
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: session.shipmentLeadId },
        });
        if (!lead) {
            throw Object.assign(new Error("Linked shipment not found for Rate Confirmation"), {
                status: 404,
            });
        }
        const content = {
            shipmentReference: lead.greenOsShipmentId || lead.loadNumber || lead.shipmentTitle,
            pickup: place(lead.pickupCity, lead.pickupState, lead.pickupZip),
            delivery: place(lead.deliveryCity, lead.deliveryState, lead.deliveryZip),
            vehicleCargo: [lead.equipment, lead.vehicle, lead.commodity, lead.weight]
                .filter(Boolean)
                .join(" · "),
            agreedRate: lead.carrierRate ?? lead.price,
            agreedRateLabel: money(lead.carrierRate ?? lead.price),
            carrierName: session.carrier.legalName,
            carrierMc: session.carrier.mcNumber,
            carrierDot: session.carrier.dotNumber,
            brokerName: "Green Logistics LLC",
            date: new Date().toISOString().slice(0, 10),
            additionalTerms: lead.specialInstructions || "",
        };
        const contentJson = JSON.stringify(content);
        const documentHash = crypto.createHash("sha256").update(contentJson).digest("hex");
        const row = await prisma.carrierRcSignature.create({
            data: {
                carrierId: session.carrierId,
                sessionId: session.sessionId,
                shipmentLeadId: session.shipmentLeadId,
                contentJson,
                signerName,
                signerEmail: session.carrier.email,
                signatureData,
                ipAddress: meta.ip || null,
                userAgent: meta.userAgent || null,
                documentHash,
            },
        });
        const archived = await this.archiveSignedRcBolPdfs({
            carrierId: session.carrierId,
            shipmentLeadId: session.shipmentLeadId,
            sessionId: session.sessionId,
            uploadedBy: "SYSTEM",
        });
        await this.emitEvent({
            carrierId: session.carrierId,
            sessionId: session.sessionId,
            shipmentLeadId: session.shipmentLeadId,
            action: "RC_SIGNED",
            title: "Rate Confirmation signed",
            message: `Signed by ${signerName}`,
            actorType: "CARRIER",
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { documentHash, ...archived },
        });
        const shipmentStatus = normalizeStatus(lead.status);
        if (["CARRIER_ASSIGNED", "RATE_CON_GENERATED"].includes(shipmentStatus)) {
            await shipmentService.transitionStatus({
                shipmentLeadId: session.shipmentLeadId,
                status: "CARRIER_ACCEPTED",
            });
        }
        return { ...row, ...archived };
    }

    /**
     * Copy current Load RC + BOL PDFs into Carrier Documents (versioned audit copies).
     */
    async archiveSignedRcBolPdfs(input: {
        carrierId: string;
        shipmentLeadId: string;
        sessionId?: string | null;
        uploadedBy?: string;
    }): Promise<{ rateConDocumentId: string | null; bolDocumentId: string | null }> {
        const out: { rateConDocumentId: string | null; bolDocumentId: string | null } = {
            rateConDocumentId: null,
            bolDocumentId: null,
        };
        for (const docType of ["RATE_CONFIRMATION", "BOL"] as const) {
            const loadDoc = await prisma.loadDocument.findFirst({
                where: {
                    shipmentLeadId: input.shipmentLeadId,
                    docType,
                    isCurrent: true,
                },
            });
            if (!loadDoc?.storedName) continue;
            const src = path.join(LOAD_DOCS_ROOT, input.shipmentLeadId, loadDoc.storedName);
            if (!fs.existsSync(src)) continue;

            const prev = await prisma.carrierDocument.findFirst({
                where: {
                    carrierId: input.carrierId,
                    documentType: docType,
                    status: "CURRENT",
                },
                orderBy: { version: "desc" },
            });
            const version = (prev?.version || 0) + 1;
            if (prev) {
                await prisma.carrierDocument.update({
                    where: { documentId: prev.documentId },
                    data: { status: "ARCHIVED" },
                });
            }

            const dir = carrierStorageService.ensureDir(input.carrierId);
            const originalFilename =
                loadDoc.fileName ||
                (docType === "RATE_CONFIRMATION"
                    ? `Rate-Confirmation-v${loadDoc.version}-signed.pdf`
                    : `BOL-v${loadDoc.version}-signed.pdf`);
            const storageKey = `${docType}_v${version}_${Date.now()}_signed.pdf`;
            const absolutePath = path.join(dir, storageKey);
            fs.copyFileSync(src, absolutePath);
            const buf = fs.readFileSync(absolutePath);
            const checksum = crypto.createHash("sha256").update(buf).digest("hex");

            const created = await prisma.carrierDocument.create({
                data: {
                    carrierId: input.carrierId,
                    shipmentLeadId: input.shipmentLeadId,
                    documentType: docType,
                    originalFilename,
                    storageKey,
                    mimeType: loadDoc.mimeType || "application/pdf",
                    fileSize: buf.length,
                    checksum,
                    uploadedBy: input.uploadedBy || "SYSTEM",
                    status: "CURRENT",
                    version,
                },
            });
            if (docType === "RATE_CONFIRMATION") out.rateConDocumentId = created.documentId;
            else out.bolDocumentId = created.documentId;
        }
        return out;
    }

    /** Backfill RC/BOL PDFs for an existing carrier signature from the linked load. */
    async regenerateRcBolPdfs(carrierId: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const latest = await prisma.carrierRcSignature.findFirst({
            where: { carrierId },
            orderBy: { signedAt: "desc" },
        });
        if (!latest?.shipmentLeadId) {
            throw Object.assign(new Error("No RC signature with a linked load found"), { status: 404 });
        }
        const archived = await this.archiveSignedRcBolPdfs({
            carrierId,
            shipmentLeadId: latest.shipmentLeadId,
            sessionId: latest.sessionId,
            uploadedBy: "STAFF",
        });
        if (!archived.rateConDocumentId && !archived.bolDocumentId) {
            throw Object.assign(
                new Error("Load RC/BOL PDFs not found. Generate them on the Load Documents tab first."),
                { status: 404 }
            );
        }
        await this.emitEvent({
            carrierId,
            shipmentLeadId: latest.shipmentLeadId,
            action: "RC_BOL_PDF_ARCHIVED",
            title: "RC/BOL PDFs archived to carrier",
            message: "Staff regenerated carrier copies of Rate Confirmation and BOL PDFs",
            actorType: "STAFF",
            actorId: actor.userId,
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: archived,
        });
        return archived;
    }

    async publicUpload(
        rawToken: string,
        input: {
            documentType: string;
            originalName: string;
            mimeType: string;
            tempPath: string;
        },
        meta: { ip?: string; userAgent?: string }
    ) {
        const session = await this.resolveSession(rawToken, meta.ip);
        const documentType = String(input.documentType || "").toUpperCase();
        const allowed = [
            "MC_AUTHORITY",
            "NOA",
            "W9",
            "INSURANCE",
            "COI",
            "BROKER_CARRIER_AGREEMENT",
            "CARRIER_PROFILE",
            "RATE_CONFIRMATION",
            "BOL",
            "POD",
            "OTHER",
        ];
        if (!allowed.includes(documentType)) {
            throw Object.assign(new Error("Invalid document type"), { status: 400 });
        }

        const prev = await prisma.carrierDocument.findFirst({
            where: { carrierId: session.carrierId, documentType, status: "CURRENT" },
            orderBy: { version: "desc" },
        });
        const version = (prev?.version || 0) + 1;
        if (prev) {
            await prisma.carrierDocument.update({
                where: { documentId: prev.documentId },
                data: { status: "ARCHIVED" },
            });
        }

        const stored = carrierStorageService.storeFromTemp({
            carrierId: session.carrierId,
            documentType,
            originalName: input.originalName,
            mimeType: input.mimeType,
            tempPath: input.tempPath,
            version,
        });

        const doc = await prisma.carrierDocument.create({
            data: {
                carrierId: session.carrierId,
                shipmentLeadId: session.shipmentLeadId,
                documentType,
                originalFilename: input.originalName,
                storageKey: stored.storageKey,
                mimeType: input.mimeType || "application/octet-stream",
                fileSize: stored.fileSize,
                checksum: stored.checksum,
                uploadedBy: "CARRIER",
                status: "CURRENT",
                version,
            },
        });

        await this.emitEvent({
            carrierId: session.carrierId,
            sessionId: session.sessionId,
            action: prev ? "DOCUMENT_REPLACED" : "DOCUMENT_UPLOADED",
            title: prev ? `${documentType} replaced` : `${documentType} uploaded`,
            message: input.originalName,
            actorType: "CARRIER",
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { documentId: doc.documentId, version, checksum: stored.checksum },
        });

        if (session.carrier.assignedBrokerId) {
            await platformNotificationService.notifyUser({
                userId: session.carrier.assignedBrokerId,
                notificationType: "CARRIER_DOCUMENT_UPLOADED",
                title: "Carrier uploaded a document",
                message: `${session.carrier.legalName} uploaded ${documentType}.`,
                meta: { carrierId: session.carrierId, documentType },
            });
        }

        return {
            documentId: doc.documentId,
            documentType: doc.documentType,
            version: doc.version,
            originalFilename: doc.originalFilename,
            uploadedAt: doc.uploadedAt,
        };
    }

    async publicSubmit(rawToken: string, meta: { ip?: string; userAgent?: string }) {
        const session = await this.resolveSession(rawToken, meta.ip);
        const snapshot = await this.publicGet(rawToken, meta);
        if (!snapshot.checklist.ready) {
            throw Object.assign(
                new Error(`Please complete:\n- ${snapshot.checklist.missing.join("\n- ")}`),
                { status: 400, missing: snapshot.checklist.missing }
            );
        }

        await prisma.$transaction(async (tx) => {
            await tx.carrierOnboardingSession.update({
                where: { sessionId: session.sessionId },
                data: { status: "SUBMITTED", submittedAt: new Date(), usedAt: new Date() },
            });
            await tx.carrier.update({
                where: { carrierId: session.carrierId },
                data: { onboardingStatus: "SUBMITTED" },
            });
            await tx.shipmentLead.updateMany({
                where: { carrierProfileId: session.carrierId },
                data: { carrierStatus: "Pending review" },
            });
        });

        await this.emitEvent({
            carrierId: session.carrierId,
            sessionId: session.sessionId,
            action: "ONBOARDING_SUBMITTED",
            title: "Onboarding submitted",
            actorType: "CARRIER",
            ip: meta.ip,
            userAgent: meta.userAgent,
        });

        const carrier = await prisma.carrier.findUnique({
            where: { carrierId: session.carrierId },
            include: {
                assignedBroker: {
                    select: {
                        userId: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        brokerGmailAccount: {
                            select: {
                                gmailAddress: true,
                                isActive: true,
                                status: true,
                                refreshToken: true,
                            },
                        },
                    },
                },
                documents: { where: { status: "CURRENT" }, orderBy: { uploadedAt: "desc" } },
                agreementSigns: { orderBy: { signedAt: "desc" }, take: 1 },
                rcSignatures: { orderBy: { signedAt: "desc" }, take: 1 },
            },
        });

        const isRcBol = (session.purpose || "") === ONBOARDING_PURPOSE.RC_BOL_PACKET;
        const docs = isRcBol
            ? ["Rate Confirmation signed", "BOL acknowledged"]
            : [
                  ...(carrier?.agreementSigns?.length ? ["Broker-Carrier Agreement signed"] : []),
                  ...(carrier?.documents || []).map(
                      (d) => `${d.documentType} — ${d.originalFilename} (v${d.version})`
                  ),
              ];

        const packageFields = carrier
            ? [
                  { label: "Legal Name", value: carrier.legalName || "" },
                  { label: "DBA", value: carrier.dbaName || "" },
                  { label: "Dispatch Contact", value: carrier.contactName || "" },
                  { label: "Email", value: carrier.email || "" },
                  { label: "Phone", value: carrier.phone || "" },
                  { label: "Fax", value: carrier.fax || "" },
                  { label: "FED ID #", value: carrier.federalTaxId || "" },
                  { label: "MC #", value: carrier.mcNumber || "" },
                  { label: "DOT #", value: carrier.dotNumber || "" },
                  { label: "Address", value: carrier.address || "" },
                  { label: "City", value: carrier.city || "" },
                  { label: "State", value: carrier.state || "" },
                  { label: "ZIP", value: carrier.zip || "" },
                  { label: "Equipment", value: carrier.equipmentNotes || "" },
                  { label: "Payment option", value: carrier.paymentOption || "" },
              ]
            : [];

        const latestSign = isRcBol
            ? carrier?.rcSignatures?.[0]
            : carrier?.agreementSigns?.[0];

        let warning: string | undefined;
        let brokerNotified = false;
        if (carrier?.assignedBroker) {
            const dest = this.brokerEmail(carrier.assignedBroker);
            warning = dest.warning;
            try {
                const sent = await carrierEmailService.sendBrokerPackageReady({
                    to: dest.email,
                    brokerUserId: carrier.assignedBroker.userId,
                    carrierLegalName: carrier.legalName,
                    mcNumber: carrier.mcNumber,
                    dotNumber: carrier.dotNumber,
                    carrierUrl: carrierEmailService.carrierRecordUrl(carrier.carrierId),
                    purposeLabel: isRcBol ? "RC / BOL signed by carrier" : "Agreement package SUBMITTED by carrier",
                    docs: docs.length ? docs : ["Package submitted"],
                    packageFields,
                    signedBy: latestSign?.signerName || null,
                    signedAt: latestSign?.signedAt
                        ? new Date(latestSign.signedAt).toLocaleString()
                        : null,
                    replyToCarrierEmail: carrier.email,
                });
                brokerNotified = true;
                await this.emitEvent({
                    carrierId: session.carrierId,
                    sessionId: session.sessionId,
                    action: "BROKER_NOTIFIED",
                    title: "Broker notified with filled package",
                    message: `Emailed filled package to ${sent.to} via ${sent.via}${
                        warning ? ` (${warning})` : ""
                    }`,
                    actorType: "SYSTEM",
                });
            } catch (err) {
                warning = err instanceof Error ? err.message : "Broker email failed";
                await this.emitEvent({
                    carrierId: session.carrierId,
                    sessionId: session.sessionId,
                    action: "BROKER_NOTIFY_FAILED",
                    title: "Broker notification failed",
                    message: warning,
                    actorType: "SYSTEM",
                });
            }

            await platformNotificationService.notifyUser({
                userId: carrier.assignedBroker.userId,
                notificationType: "CARRIER_ONBOARDING_SUBMITTED",
                title: "Carrier package ready",
                message: `${carrier.legalName} submitted ${
                    isRcBol ? "RC/BOL" : "agreement documents"
                }.`,
                meta: { carrierId: carrier.carrierId },
            });
        } else {
            warning = "No assigned broker — filled package saved in Green OS only";
        }

        return {
            success: true,
            brokerNotified,
            warning,
            message: brokerNotified
                ? "Thank you. Your carrier package has been successfully submitted to Green Logistics. Your broker was emailed the filled package."
                : "Thank you. Your carrier package has been successfully submitted to Green Logistics." +
                  (warning ? ` (Broker email: ${warning})` : ""),
        };
    }

    async downloadDocument(carrierId: string, documentId: string, actor: Actor) {
        await this.assertCarrierAccess(carrierId, actor);
        const doc = await prisma.carrierDocument.findFirst({
            where: { documentId, carrierId },
        });
        if (!doc) throw Object.assign(new Error("Document not found"), { status: 404 });
        const absolutePath = carrierStorageService.absolutePath(carrierId, doc.storageKey);
        return { doc, absolutePath };
    }

    /** Public RC/BOL PDF download for carrier portal (token-scoped). */
    async publicDownloadLoadDocument(rawToken: string, documentId: string, ip?: string) {
        const session = await this.resolveSession(rawToken, ip);
        if (!session.shipmentLeadId) {
            throw Object.assign(new Error("No load linked to this invitation"), { status: 404 });
        }
        const row = await prisma.loadDocument.findFirst({
            where: {
                documentId,
                shipmentLeadId: session.shipmentLeadId,
                docType: { in: ["RATE_CONFIRMATION", "BOL"] },
                isCurrent: true,
            },
        });
        if (!row || !row.storedName) {
            throw Object.assign(new Error("Document PDF not found"), { status: 404 });
        }
        const absolutePath = path.join(LOAD_DOCS_ROOT, row.shipmentLeadId, row.storedName);
        if (!fs.existsSync(absolutePath)) {
            throw Object.assign(new Error("PDF file missing on disk"), { status: 404 });
        }
        return {
            absolutePath,
            fileName: row.fileName || `${row.docType}.pdf`,
            mimeType: row.mimeType || "application/pdf",
        };
    }
}

export const carrierService = new CarrierService();

/** Exported for tests */
export const _carrierTestUtils = { hashToken, newRawToken };

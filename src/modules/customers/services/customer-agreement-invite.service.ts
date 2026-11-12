import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { brokerGmailOAuthService } from "../../email/gmail/broker-gmail-oauth.service.js";
import { loadDocumentsService } from "../../shipment/services/load-documents.service.js";
import type { CustomerAgreementType } from "../customer-agreement.js";
import {
    buildSignedCustomerAgreementBrokerEmail,
    customerAgreementFilename,
    customerAgreementLabel,
} from "../customer-agreement.js";
import {
    customerAgreementFields,
    customerAgreementSections,
    prefillCustomerAgreementFields,
} from "../customer-agreement-fields.js";
import { buildCustomerAgreementPdf } from "../customer-agreement-pdf.js";

function hashToken(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
}

function newRawToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}

function signedPdfDir(): string {
    const dir = path.join(process.cwd(), "data", "customer-agreements");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function fmtSignedAt(d: Date): string {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: config.timezone || "America/Los_Angeles",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        }).format(d);
    } catch {
        return d.toISOString();
    }
}

export class CustomerAgreementInviteService {
    async createInvite(input: {
        customerId: string;
        agreementType: CustomerAgreementType;
        brokerUserId: string;
        companyName: string;
        contactName?: string | null;
        email?: string | null;
        phone?: string | null;
        billingAddress?: string | null;
        city?: string | null;
        state?: string | null;
        zip?: string | null;
        shipmentLeadId?: string | null;
    }): Promise<{
        inviteId: string;
        rawToken: string;
        signUrl: string;
        brokerName: string;
        pdf: Buffer;
        pdfFilename: string;
        label: string;
        sentAt: Date;
        shipmentLeadId: string | null;
    }> {
        const broker = await prisma.user.findUnique({
            where: { userId: input.brokerUserId },
            select: { firstName: true, lastName: true, username: true },
        });
        const brokerName =
            `${broker?.firstName || ""} ${broker?.lastName || ""}`.trim() ||
            broker?.username ||
            "Broker";
        const rawToken = newRawToken();
        const tokenHash = hashToken(rawToken);
        const sentAt = new Date();
        const expiresAt = new Date(sentAt.getTime() + 30 * 24 * 60 * 60 * 1000);
        let shipmentLeadId = String(input.shipmentLeadId || "").trim() || null;
        let shipmentPrefill: Parameters<typeof prefillCustomerAgreementFields>[0]["shipment"] = null;
        const leadSelect = {
            shipmentLeadId: true,
            loadNumber: true,
            greenOsShipmentId: true,
            shipmentTitle: true,
            commodity: true,
            pieces: true,
            weight: true,
            equipment: true,
            specialInstructions: true,
            pickupCity: true,
            pickupState: true,
            pickupZip: true,
            deliveryCity: true,
            deliveryState: true,
            deliveryZip: true,
            pickupFrom: true,
            deliveryFrom: true,
            customerRate: true,
            price: true,
            customerPaymentMethod: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            waiveCustomerPaymentFee: true,
        } as const;
        let lead = shipmentLeadId
            ? await prisma.shipmentLead.findUnique({
                  where: { shipmentLeadId },
                  select: leadSelect,
              })
            : null;
        if (!lead) {
            lead = await prisma.shipmentLead.findFirst({
                where: {
                    directCustomerId: input.customerId,
                    loadNumber: { not: null },
                },
                orderBy: { updatedAt: "desc" },
                select: leadSelect,
            });
            if (lead?.shipmentLeadId) shipmentLeadId = lead.shipmentLeadId;
        }
        if (lead) {
            const { customerPaymentQuote } = await import("../../shipment/customer-payment.js");
            const pay = customerPaymentQuote({
                customerRate: lead.customerRate,
                method: lead.customerPaymentMethod,
                waiveFee: lead.waiveCustomerPaymentFee,
            });
            shipmentPrefill = {
                ...lead,
                customerPaymentLabel: pay.label,
            };
        }
        const fields = prefillCustomerAgreementFields({
            agreementType: input.agreementType,
            companyName: input.companyName,
            contactName: input.contactName,
            email: input.email,
            phone: input.phone,
            billingAddress: input.billingAddress,
            city: input.city,
            state: input.state,
            zip: input.zip,
            shipment: shipmentPrefill,
            timezone: config.timezone,
        });

        await prisma.customerAgreementInvite.updateMany({
            where: {
                customerId: input.customerId,
                agreementType: input.agreementType,
                status: "ACTIVE",
            },
            data: { status: "REVOKED" },
        });

        const invite = await prisma.customerAgreementInvite.create({
            data: {
                customerId: input.customerId,
                shipmentLeadId,
                agreementType: input.agreementType,
                tokenHash,
                brokerUserId: input.brokerUserId,
                brokerName,
                brokerTitle: "Broker",
                sentAt,
                expiresAt,
                status: "ACTIVE",
                fieldsJson: JSON.stringify(fields),
            },
        });

        const pdf = await buildCustomerAgreementPdf({
            agreementType: input.agreementType,
            companyName: input.companyName,
            brokerName,
            brokerTitle: "Broker",
            sentAt,
            fields,
            timezone: config.timezone,
        });

        const pdfFilename = customerAgreementFilename(input.agreementType).replace(
            /\.docx$/i,
            ".pdf"
        );
        const signUrl = `${config.publicAppUrl}/customer/agreement/${encodeURIComponent(rawToken)}`;
        return {
            inviteId: invite.inviteId,
            rawToken,
            signUrl,
            brokerName,
            pdf,
            pdfFilename,
            label: customerAgreementLabel(input.agreementType),
            sentAt,
            shipmentLeadId,
        };
    }

    async getByToken(rawToken: string) {
        const tokenHash = hashToken(String(rawToken || "").trim());
        const invite = await prisma.customerAgreementInvite.findUnique({
            where: { tokenHash },
            include: {
                customer: {
                    select: {
                        customerId: true,
                        companyName: true,
                        contactName: true,
                        email: true,
                        phone: true,
                    },
                },
            },
        });
        if (!invite) {
            throw Object.assign(new Error("Agreement link is invalid"), { status: 404 });
        }
        if (invite.status === "REVOKED") {
            throw Object.assign(new Error("This agreement link was replaced. Ask your broker for a new link."), {
                status: 410,
            });
        }
        if (invite.expiresAt.getTime() < Date.now() && invite.status !== "SIGNED") {
            await prisma.customerAgreementInvite.update({
                where: { inviteId: invite.inviteId },
                data: { status: "EXPIRED" },
            });
            throw Object.assign(new Error("This agreement link has expired"), { status: 410 });
        }
        const agreementType = invite.agreementType as CustomerAgreementType;
        let fields: Record<string, string> = {};
        try {
            fields = JSON.parse(invite.fieldsJson || "{}");
        } catch {
            fields = {};
        }
        return {
            inviteId: invite.inviteId,
            status: invite.status,
            agreementType,
            label: customerAgreementLabel(agreementType),
            title:
                agreementType === "LONG_TIME"
                    ? "Master Customer–Broker Agreement"
                    : "Customer–Broker Agreement",
            broker: {
                name: invite.brokerName,
                title: invite.brokerTitle || "Broker",
            },
            sentAt: invite.sentAt,
            signedAt: invite.signedAt,
            customer: invite.customer,
            fields,
            fieldDefs: customerAgreementFields(agreementType),
            sections: customerAgreementSections(agreementType),
            alreadySigned: invite.status === "SIGNED",
            shipmentLeadId: invite.shipmentLeadId || null,
        };
    }

    async saveFields(rawToken: string, fields: Record<string, unknown>) {
        const current = await this.getByToken(rawToken);
        if (current.alreadySigned) {
            throw Object.assign(new Error("This agreement is already signed"), { status: 422 });
        }
        const cleaned: Record<string, string> = { ...current.fields };
        for (const def of current.fieldDefs) {
            if (fields[def.key] !== undefined) {
                cleaned[def.key] = String(fields[def.key] ?? "").trim();
            }
        }
        await prisma.customerAgreementInvite.update({
            where: { inviteId: current.inviteId },
            data: { fieldsJson: JSON.stringify(cleaned) },
        });
        return { ok: true, fields: cleaned };
    }

    /** Prefer invite.shipmentLeadId; else latest load for this direct customer. */
    async resolveShipmentLeadIdForInvite(invite: {
        shipmentLeadId?: string | null;
        customerId: string;
    }): Promise<{ shipmentLeadId: string; loadNumber: string | null } | null> {
        if (invite.shipmentLeadId) {
            const lead = await prisma.shipmentLead.findUnique({
                where: { shipmentLeadId: invite.shipmentLeadId },
                select: { shipmentLeadId: true, loadNumber: true },
            });
            if (lead?.loadNumber) {
                return { shipmentLeadId: lead.shipmentLeadId, loadNumber: lead.loadNumber };
            }
        }
        const latest = await prisma.shipmentLead.findFirst({
            where: {
                directCustomerId: invite.customerId,
                loadNumber: { not: null },
            },
            orderBy: { updatedAt: "desc" },
            select: { shipmentLeadId: true, loadNumber: true },
        });
        if (!latest?.shipmentLeadId) return null;
        return { shipmentLeadId: latest.shipmentLeadId, loadNumber: latest.loadNumber };
    }

    async sign(
        rawToken: string,
        body: { signerName?: string; signatureData?: string; fields?: Record<string, unknown> }
    ) {
        const current = await this.getByToken(rawToken);
        if (current.alreadySigned) {
            throw Object.assign(new Error("This agreement is already signed"), { status: 422 });
        }
        const signerName = String(body.signerName || "").trim();
        const signatureData = String(body.signatureData || "").trim();
        if (!signerName) {
            throw Object.assign(new Error("Signer name is required"), { status: 422 });
        }
        if (!signatureData.startsWith("data:image")) {
            throw Object.assign(new Error("Signature is required"), { status: 422 });
        }
        if (body.fields) {
            await this.saveFields(rawToken, body.fields);
        }
        const refreshed = await this.getByToken(rawToken);
        const signedAt = new Date();
        const invite = await prisma.customerAgreementInvite.findUniqueOrThrow({
            where: { inviteId: refreshed.inviteId },
        });
        const pdf = await buildCustomerAgreementPdf({
            agreementType: refreshed.agreementType,
            companyName: refreshed.customer.companyName,
            brokerName: invite.brokerName,
            brokerTitle: invite.brokerTitle || "Broker",
            sentAt: invite.sentAt,
            fields: refreshed.fields,
            customerSignatureDataUrl: signatureData,
            customerSignerName: signerName,
            signedAt,
            timezone: config.timezone,
        });
        const storageKey = `${invite.inviteId}-signed.pdf`;
        fs.writeFileSync(path.join(signedPdfDir(), storageKey), pdf);
        await prisma.customerAgreementInvite.update({
            where: { inviteId: invite.inviteId },
            data: {
                status: "SIGNED",
                customerSignerName: signerName,
                customerSignatureData: signatureData,
                signedAt,
                signedPdfStorageKey: storageKey,
                fieldsJson: JSON.stringify(refreshed.fields),
            },
        });

        const loadRef = await this.resolveShipmentLeadIdForInvite(invite).catch(() => null);
        let loadDocumentId: string | null = null;
        let archiveWarning: string | null = null;
        if (loadRef?.shipmentLeadId) {
            if (!invite.shipmentLeadId) {
                await prisma.customerAgreementInvite
                    .update({
                        where: { inviteId: invite.inviteId },
                        data: { shipmentLeadId: loadRef.shipmentLeadId },
                    })
                    .catch(() => undefined);
            }
            try {
                const stored = await loadDocumentsService.storeSignedCustomerAgreement({
                    shipmentLeadId: loadRef.shipmentLeadId,
                    pdf,
                    fileName: customerAgreementFilename(refreshed.agreementType).replace(
                        /\.docx$/i,
                        "-signed.pdf"
                    ),
                    actorUserId: invite.brokerUserId,
                });
                loadDocumentId = stored.documentId;
            } catch (err) {
                archiveWarning = err instanceof Error ? err.message : String(err);
                console.warn(
                    `[customer-agreement] archive signed PDF to load failed for ${loadRef.shipmentLeadId}:`,
                    archiveWarning
                );
            }
        } else {
            archiveWarning = "No Load linked to this customer yet — Accounting will show MISSING until a Load exists.";
            console.warn(
                `[customer-agreement] signed invite ${invite.inviteId} has no shipmentLeadId / load to archive`
            );
        }

        let brokerEmail: {
            sent: boolean;
            to?: string;
            from?: string;
            error?: string;
        } = { sent: false };
        try {
            const account = await prisma.brokerGmailAccount.findUnique({
                where: { userId: invite.brokerUserId },
                select: { gmailAddress: true, isActive: true, status: true, refreshToken: true },
            });
            const to = String(account?.gmailAddress || "").trim();
            if (!to || !to.includes("@")) {
                brokerEmail = {
                    sent: false,
                    error: "Broker Gmail is not connected — signed PDF was not emailed to the broker.",
                };
            } else {
                const mail = buildSignedCustomerAgreementBrokerEmail({
                    companyName: refreshed.customer.companyName,
                    agreementType: refreshed.agreementType,
                    brokerName: invite.brokerName,
                    signerName,
                    signedAtLabel: fmtSignedAt(signedAt),
                    loadNumber: loadRef?.loadNumber || null,
                });
                const filename = customerAgreementFilename(refreshed.agreementType).replace(
                    /\.docx$/i,
                    "-signed.pdf"
                );
                const sent = await brokerGmailOAuthService.sendMailAsBroker(invite.brokerUserId, {
                    to,
                    subject: mail.subject,
                    text: mail.text,
                    html: mail.html,
                    attachments: [
                        {
                            filename,
                            content: pdf,
                            contentType: "application/pdf",
                        },
                    ],
                });
                brokerEmail = { sent: true, to, from: sent.from };
            }
        } catch (err) {
            brokerEmail = {
                sent: false,
                error: err instanceof Error ? err.message : String(err),
            };
            console.warn(
                `[customer-agreement] broker signed-PDF email failed for invite ${invite.inviteId}:`,
                brokerEmail.error
            );
        }

        return {
            ok: true,
            signedAt,
            loadDocumentId,
            archiveWarning,
            brokerEmail,
            message: brokerEmail.sent
                ? "Agreement signed. The completed PDF was emailed to your broker and saved for Accounting."
                : "Agreement signed. Thank you — Green Logistics has your completed agreement.",
        };
    }

    async readSignedPdf(rawToken: string): Promise<{ filename: string; content: Buffer } | null> {
        const current = await this.getByToken(rawToken);
        const invite = await prisma.customerAgreementInvite.findUnique({
            where: { inviteId: current.inviteId },
            select: { signedPdfStorageKey: true, agreementType: true },
        });
        if (!invite?.signedPdfStorageKey) return null;
        const full = path.join(signedPdfDir(), invite.signedPdfStorageKey);
        if (!fs.existsSync(full)) return null;
        return {
            filename: customerAgreementFilename(invite.agreementType as CustomerAgreementType).replace(
                /\.docx$/i,
                "-signed.pdf"
            ),
            content: fs.readFileSync(full),
        };
    }
}

export const customerAgreementInviteService = new CustomerAgreementInviteService();

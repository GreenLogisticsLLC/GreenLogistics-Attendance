import { prisma } from "../../../config/database.js";
import { sendMail } from "../../../services/email.service.js";
import { carrierEmailService } from "../../carriers/services/carrier-email.service.js";
import { isSensitiveDocType } from "./constants.js";
import { actionError } from "./acl.js";
import type { AiActionActor, AiActionPayload } from "./types.js";

/** Test seam — never send real mail in automated tests. */
export type AiActionEmailSendFn = (input: {
    brokerUserId: string | null;
    to: string;
    subject: string;
    text: string;
    html: string;
}) => Promise<{ via: string; from: string }>;

let emailSendOverride: AiActionEmailSendFn | null = null;

export function _setAiActionEmailSendForTests(fn: AiActionEmailSendFn | null): void {
    emailSendOverride = fn;
}

function asRecord(p: AiActionPayload): Record<string, unknown> {
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}
function str(v: unknown): string {
    return String(v ?? "").trim();
}
function sanitizeHeader(value: string): string {
    return value.replace(/[\r\n]+/g, " ").trim();
}
function looksLikeEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function resolveCarrierEmail(carrierId: string): Promise<string | null> {
    const c = await prisma.carrier.findUnique({
        where: { carrierId },
        select: { email: true },
    });
    return c?.email?.trim() || null;
}

async function resolveShipmentCarrierEmail(shipmentLeadId: string): Promise<string | null> {
    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId },
        select: { carrierEmail: true, carrierProfileId: true },
    });
    if (lead?.carrierEmail && looksLikeEmail(lead.carrierEmail)) {
        return lead.carrierEmail.trim();
    }
    if (lead?.carrierProfileId) return resolveCarrierEmail(lead.carrierProfileId);
    return null;
}

export async function resolveAuthorizedRecipient(input: {
    targetType: string;
    targetId: string | null;
    proposedTo?: string;
}): Promise<{ to: string }> {
    let stored: string | null = null;

    if (input.targetType === "carrier" && input.targetId) {
        stored = await resolveCarrierEmail(input.targetId);
    } else if (input.targetType === "shipment" && input.targetId) {
        stored = await resolveShipmentCarrierEmail(input.targetId);
    }

    if (!stored || !looksLikeEmail(stored)) {
        throw actionError(
            "No authorized recipient email on file in GreenOS — action requires review",
            422,
            "REQUIRES_REVIEW"
        );
    }

    const proposed = sanitizeHeader(str(input.proposedTo));
    if (proposed && looksLikeEmail(proposed) && proposed.toLowerCase() !== stored.toLowerCase()) {
        throw actionError(
            "Recipient does not match GreenOS-stored contact — action requires review",
            422,
            "REQUIRES_REVIEW"
        );
    }

    return { to: stored };
}

export async function executeSendEmail(
    actor: AiActionActor,
    targetType: string,
    targetId: string | null,
    payload: AiActionPayload
): Promise<Record<string, unknown>> {
    const p = asRecord(payload);
    const subject = sanitizeHeader(str(p.subject));
    const bodyText = str(p.bodyText || p.body);
    if (!subject || !bodyText) {
        throw actionError("Email subject and body are required", 422, "INVALID_PAYLOAD");
    }
    if (subject.length > 200 || bodyText.length > 20000) {
        throw actionError("Email content exceeds allowed length", 422, "INVALID_PAYLOAD");
    }

    const attachments = Array.isArray(p.attachmentDocumentIds)
        ? (p.attachmentDocumentIds as unknown[]).map((x) => String(x))
        : [];
    if (attachments.length) {
        for (const docId of attachments) {
            const doc = await prisma.carrierDocument.findUnique({
                where: { documentId: docId },
                select: { documentType: true, carrierId: true },
            });
            if (!doc) {
                throw actionError("Attachment document not found", 404, "UNAUTHORIZED_ATTACHMENT");
            }
            if (isSensitiveDocType(doc.documentType)) {
                throw actionError(
                    "Sensitive documents (e.g. W-9/TIN) cannot be emailed via AI actions",
                    422,
                    "SENSITIVE_ATTACHMENT_REJECTED"
                );
            }
            if (targetType === "carrier" && targetId && doc.carrierId !== targetId) {
                throw actionError(
                    "Attachment does not belong to target carrier",
                    403,
                    "UNAUTHORIZED_ATTACHMENT"
                );
            }
        }
        throw actionError(
            "Email attachments are not supported in Phase 6 AI actions",
            422,
            "ATTACHMENTS_NOT_SUPPORTED"
        );
    }

    const { to } = await resolveAuthorizedRecipient({
        targetType,
        targetId,
        proposedTo: str(p.to),
    });

    let brokerUserId: string | null = actor.userId;
    if (targetType === "carrier" && targetId) {
        const c = await prisma.carrier.findUnique({
            where: { carrierId: targetId },
            select: { assignedBrokerId: true },
        });
        brokerUserId = c?.assignedBrokerId || actor.userId;
    }

    const html = `<pre style="font-family:inherit;white-space:pre-wrap">${bodyText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`;

    if (emailSendOverride) {
        const sent = await emailSendOverride({
            brokerUserId,
            to,
            subject,
            text: bodyText,
            html,
        });
        return { to, subject, via: sent.via, from: sent.from };
    }

    try {
        const sent = await carrierEmailService.sendAsBrokerOrSystem({
            brokerUserId,
            to,
            subject,
            text: bodyText,
            html,
            allowSystemFallback: true,
        });
        return { to, subject, via: sent.via, from: sent.from };
    } catch {
        await sendMail({ to, subject, text: bodyText, html });
        return { to, subject, via: "system" };
    }
}

export async function executeCreateInternalNote(
    actor: AiActionActor,
    targetType: string,
    targetId: string | null,
    payload: AiActionPayload
): Promise<Record<string, unknown>> {
    const noteText = str(asRecord(payload).noteText || asRecord(payload).text);
    if (!noteText || noteText.length < 2) {
        throw actionError("Note text is required", 422, "INVALID_PAYLOAD");
    }
    if (!targetId) throw actionError("targetId required", 422, "INVALID_TARGET");

    const stamp = new Date().toISOString();
    const entry = `[AI NOTE ${stamp} by ${actor.userId}] ${noteText}`;

    if (targetType === "carrier") {
        const c = await prisma.carrier.findUnique({
            where: { carrierId: targetId },
            select: { notes: true },
        });
        const next = [c?.notes || "", entry].filter(Boolean).join("\n\n");
        await prisma.carrier.update({
            where: { carrierId: targetId },
            data: { notes: next.slice(0, 20000) },
        });
        return { targetType, targetId, noteLength: noteText.length };
    }

    if (targetType === "shipment") {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: targetId },
            select: { aiNotes: true, notes: true },
        });
        const next = [lead?.aiNotes || lead?.notes || "", entry].filter(Boolean).join("\n\n");
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: targetId },
            data: { aiNotes: next.slice(0, 20000) },
        });
        return { targetType, targetId, noteLength: noteText.length };
    }

    throw actionError("Internal notes only supported for carrier or shipment", 422, "INVALID_TARGET");
}

export async function executeCreateFollowUp(
    actor: AiActionActor,
    targetType: string,
    targetId: string | null,
    payload: AiActionPayload
): Promise<Record<string, unknown>> {
    const p = asRecord(payload);
    const noteText = str(p.noteText || p.text) || "Follow-up required";
    const dueDate = str(p.dueDate);

    if (targetType === "shipment" && targetId) {
        const lead = await prisma.shipmentLead.findUnique({
            where: { shipmentLeadId: targetId },
            select: { status: true, aiNotes: true },
        });
        if (!lead) throw actionError("Shipment not found", 404, "NOT_FOUND");
        const terminal = ["CLOSED", "LOST", "ACCEPTED_ANOTHER_COMPANY", "DELETED_FROM_CUSTOMER", "DELETED"];
        if (terminal.includes(String(lead.status || "").toUpperCase())) {
            throw actionError("Cannot create follow-up on closed/lost shipment", 422, "STALE_ACTION");
        }
        const stamp = new Date().toISOString();
        const entry = `[FOLLOW-UP ${stamp}${dueDate ? ` due ${dueDate}` : ""}] ${noteText}`;
        const next = [lead.aiNotes || "", entry].filter(Boolean).join("\n\n");
        await prisma.shipmentLead.update({
            where: { shipmentLeadId: targetId },
            data: { status: "FOLLOW_UP", aiNotes: next.slice(0, 20000) },
        });
        return { targetType, targetId, status: "FOLLOW_UP", dueDate: dueDate || null };
    }

    if (targetType === "carrier" && targetId) {
        const noteResult = await executeCreateInternalNote(actor, "carrier", targetId, {
            noteText: `[FOLLOW-UP${dueDate ? ` due ${dueDate}` : ""}] ${noteText}`,
        });
        return { ...noteResult, followUp: true, dueDate: dueDate || null };
    }

    throw actionError("Follow-up requires carrier or shipment target", 422, "INVALID_TARGET");
}

export async function executeRequestDocument(
    actor: AiActionActor,
    targetType: string,
    targetId: string | null,
    payload: AiActionPayload
): Promise<Record<string, unknown>> {
    const p = asRecord(payload);
    const documentType = str(p.documentType || p.docType);
    if (!documentType) throw actionError("documentType is required", 422, "INVALID_PAYLOAD");

    const subject =
        sanitizeHeader(str(p.subject)) || `Document request: ${documentType} — Green Logistics`;
    const bodyText =
        str(p.bodyText || p.body) ||
        `Hello,\n\nPlease provide an updated ${documentType} for our records.\n\nThank you,\nGreen Logistics`;

    const emailResult = await executeSendEmail(actor, targetType, targetId, {
        to: str(p.to),
        subject,
        bodyText,
        documentTypeRequested: documentType,
    });
    return { documentType, email: emailResult };
}

export async function executeMarkReviewRequired(
    _actor: AiActionActor,
    targetType: string,
    targetId: string | null,
    payload: AiActionPayload
): Promise<Record<string, unknown>> {
    const p = asRecord(payload);
    const jobId = str(p.jobId) || (targetType === "document_job" ? str(targetId) : "");
    if (!jobId) throw actionError("jobId is required", 422, "INVALID_PAYLOAD");

    const job = await prisma.aiDocumentJob.findUnique({
        where: { jobId },
        include: { validation: true },
    });
    if (!job) throw actionError("Document job not found", 404, "NOT_FOUND");
    if (!job.validation) throw actionError("No validation result for this job", 422, "STALE_ACTION");

    if (job.validation.requiresReview) {
        return {
            jobId,
            alreadyRequired: true,
            overallStatus: job.validation.overallStatus,
            masterDataMutated: false,
        };
    }

    await prisma.documentValidationResult.update({
        where: { jobId },
        // Phase 6 may flag a validation for human review, but it must not
        // make a review decision or mutate carrier master data.
        data: { requiresReview: true },
    });

    return { jobId, requiresReview: true, masterDataMutated: false };
}

export async function checkStaleForRequestDocument(
    targetType: string,
    targetId: string | null,
    documentType: string
): Promise<void> {
    if (targetType !== "carrier" || !targetId || !documentType) return;
    const docs = await prisma.carrierDocument.findMany({
        where: { carrierId: targetId, status: "CURRENT" },
        select: { documentType: true },
        orderBy: { uploadedAt: "desc" },
        take: 40,
    });
    const needle = documentType.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const match = docs.find((d) => {
        const t = String(d.documentType || "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
        return t.includes(needle) || needle.includes(t);
    });
    if (match) {
        throw actionError(
            `${documentType} appears present now — create a new proposal if still needed`,
            409,
            "STALE_ACTION"
        );
    }
}

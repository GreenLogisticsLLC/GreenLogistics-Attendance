import fs from "fs";
import path from "path";
import crypto from "crypto";
import { prisma } from "../../../config/database.js";
import { config } from "../../../config/env.js";
import { Roles } from "../../../auth/roles.js";
import { domainEventEngine } from "./domain-event.engine.js";
import { platformNotificationService } from "./platform-notification.service.js";
import { shipmentService } from "./shipment.service.js";
import { LOAD_DOCS_ROOT } from "./load-pdf.service.js";
import {
    assertQuickActionAllowed,
    quickActionIdForDocType,
} from "../load-quick-actions.js";

export type PodAnalysis = {
    matchesBol: boolean;
    loadNumberFound: string | null;
    hasReceiverSignature: boolean;
    hasExceptionNotes: boolean;
    exceptionSummary: string | null;
    confidence: number;
    analysisNotes: string;
    method: "openai_vision" | "openai_text" | "heuristic";
};

const POD_MANUAL_APPROVER_ROLES: Set<string> = new Set([
    Roles.TeamLead,
    Roles.Manager,
    Roles.Accounting,
]);

function safeFileName(name: string): string {
    return (
        String(name || "pod")
            .replace(/[^\w.\- ()[\]]+/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120) || "pod"
    );
}

function crudePdfOrImageText(buf: Buffer): string {
    const raw = buf.toString("latin1");
    return raw
        .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 12000);
}

function heuristicAnalyze(
    buf: Buffer,
    loadNumber: string,
    confirmSignature: boolean
): PodAnalysis {
    const text = crudePdfOrImageText(buf);
    const ln = String(loadNumber || "").trim();
    const matchesBol = ln
        ? text.toUpperCase().includes(ln.toUpperCase()) || buf.toString("utf8").includes(ln)
        : false;
    const noteHints =
        /\b(exception|damage|damaged|shortage|short|note|notes|remark|remarks|wet|scratch| scratched|refused|delay)\b/i.test(
            text
        );
    return {
        matchesBol,
        loadNumberFound: matchesBol ? ln : null,
        hasReceiverSignature: confirmSignature,
        hasExceptionNotes: noteHints,
        exceptionSummary: noteHints ? "Possible delivery notes detected in file text" : null,
        confidence: matchesBol ? 0.45 : 0.2,
        analysisNotes: confirmSignature
            ? "Heuristic check (broker confirmed receiver signature)."
            : "Heuristic check — confirm receiver signature if AI is unavailable.",
        method: "heuristic",
    };
}

async function openaiAnalyzePod(input: {
    buf: Buffer;
    mimeType: string;
    loadNumber: string;
    bolSummary: string;
}): Promise<PodAnalysis | null> {
    if (!config.openai.apiKey) return null;

    const system = `You verify Proof of Delivery (POD) for Green Logistics.
The POD is the same Bill of Lading (BOL) after delivery, with the RECEIVER signature filled in.

Look specifically for the delivery receipt block with text like:
"GOOD ORDER, COUNT AND CONDITION VERIFIED EXCEPT AS NOTED BELOW"
and the box labeled "SIGNATURE" (often next to an empty "DATE" box).

Rules for hasReceiverSignature:
- true if that SIGNATURE box (or RECEIVER / CONSIGNEE signature area) contains ANY handwritten ink, scribble, mark, stamp, or digital pen stroke — even messy, red, incomplete, or illegible.
- An ink scribble in SIGNATURE means the receiver signed that they received the cargo → treat as valid POD signature.
- false ONLY if the SIGNATURE box is clearly empty / blank with no marks.

hasExceptionNotes = true only if there are handwritten remarks, damage notes, shortages, or other notes beyond the signature itself (e.g. in exceptions area). A signature alone is NOT an exception.

matchesBol = true if the document matches this load/BOL number or the described route/carrier.

Return ONLY JSON:
matchesBol (boolean), loadNumberFound (string|null), hasReceiverSignature (boolean),
hasExceptionNotes (boolean), exceptionSummary (string|null), confidence (0-1), analysisNotes (string).`;

    const userText = `Expected Load/BOL #: ${input.loadNumber}
BOL context:
${input.bolSummary}

Focus on the SIGNATURE box in the receiver delivery section. If there is any mark/scribble there, set hasReceiverSignature=true (POD is complete).`;

    const model = config.openai.model || "gpt-4o";
    const isImage = String(input.mimeType || "").startsWith("image/");
    const content: Array<Record<string, unknown>> = [{ type: "text", text: userText }];

    if (isImage) {
        const b64 = input.buf.toString("base64");
        content.push({
            type: "image_url",
            image_url: {
                url: `data:${input.mimeType};base64,${b64}`,
                detail: "high",
            },
        });
    } else {
        content[0] = {
            type: "text",
            text:
                userText +
                "\n\nExtracted file text (may be incomplete for scans):\n" +
                crudePdfOrImageText(input.buf).slice(0, 8000),
        };
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            max_completion_tokens: 600,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: system },
                { role: "user", content },
            ],
        }),
    });

    const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
    };
    if (!res.ok) {
        throw Object.assign(new Error(data?.error?.message || `OpenAI HTTP ${res.status}`), {
            status: 502,
        });
    }
    const raw = data.choices?.[0]?.message?.content || "{}";
    let parsed: Record<string, unknown> = {};
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = {};
    }
    return {
        matchesBol: Boolean(parsed.matchesBol),
        loadNumberFound: parsed.loadNumberFound ? String(parsed.loadNumberFound) : null,
        hasReceiverSignature: Boolean(parsed.hasReceiverSignature),
        hasExceptionNotes: Boolean(parsed.hasExceptionNotes),
        exceptionSummary: parsed.exceptionSummary ? String(parsed.exceptionSummary) : null,
        confidence: Number(parsed.confidence) || 0,
        analysisNotes: String(parsed.analysisNotes || ""),
        method: isImage ? "openai_vision" : "openai_text",
    };
}

async function notifyTeamLeadOfExceptions(input: {
    shipmentLeadId: string;
    loadNumber: string | null;
    brokerUserId: string | null;
    exceptionSummary: string | null;
    analysisNotes: string;
}) {
    const title = `POD exceptions on Load ${input.loadNumber || input.shipmentLeadId}`;
    const message =
        (input.exceptionSummary || "POD uploaded with delivery notes / exceptions.") +
        (input.analysisNotes ? ` ${input.analysisNotes}` : "");

    let teamLeadId: string | null = null;
    if (input.brokerUserId) {
        const broker = await prisma.user.findUnique({
            where: { userId: input.brokerUserId },
            select: { teamLeadId: true, firstName: true, lastName: true },
        });
        teamLeadId = broker?.teamLeadId || null;
    }

    if (teamLeadId) {
        await platformNotificationService.notifyUser({
            userId: teamLeadId,
            notificationType: "POD_EXCEPTIONS",
            title,
            message,
            shipmentLeadId: input.shipmentLeadId,
            meta: { loadNumber: input.loadNumber, exceptionSummary: input.exceptionSummary },
        });
        return { notified: "team_lead" as const, userId: teamLeadId };
    }

    await platformNotificationService.notifyRoles({
        roles: [Roles.TeamLead, Roles.Manager, Roles.Owner],
        notificationType: "POD_EXCEPTIONS",
        title,
        message,
        shipmentLeadId: input.shipmentLeadId,
        meta: { loadNumber: input.loadNumber, exceptionSummary: input.exceptionSummary },
    });
    return { notified: "roles" as const, userId: null };
}

/**
 * Upload signed BOL-as-POD, verify against current BOL, require receiver signature,
 * and alert the broker's Team Lead when exception notes are present.
 */
export async function uploadPodFile(input: {
    shipmentLeadId: string;
    actorUserId?: string;
    originalName: string;
    mimeType: string;
    tempPath: string;
    /** Broker override when AI cannot see signature (images preferred). */
    confirmSignature?: boolean;
    actorRole?: string;
    /** Restricted staff override when automated BOL/signature checks fail. */
    manualApprove?: boolean;
    manualApprovalReason?: string;
}) {
    const manualApproval = Boolean(input.manualApprove);
    if (manualApproval && !POD_MANUAL_APPROVER_ROLES.has(String(input.actorRole || ""))) {
        throw Object.assign(
            new Error("Only Team Lead, Manager, or Accounting can manually approve POD"),
            { status: 403, code: "POD_MANUAL_APPROVAL_FORBIDDEN" }
        );
    }
    const manualApprovalReason = String(input.manualApprovalReason || "").trim();
    if (manualApproval && !manualApprovalReason) {
        throw Object.assign(new Error("Manual approval reason is required"), {
            status: 422,
            code: "POD_MANUAL_REASON_REQUIRED",
        });
    }

    const lead = await prisma.shipmentLead.findUnique({
        where: { shipmentLeadId: input.shipmentLeadId },
    });
    if (!lead) throw Object.assign(new Error("Load not found"), { status: 404 });
    if (!lead.loadNumber) {
        throw Object.assign(new Error("Create Load first"), { status: 422 });
    }

    const existingDocs = await prisma.loadDocument.findMany({
        where: {
            shipmentLeadId: input.shipmentLeadId,
            isCurrent: true,
            status: { not: "ARCHIVED" },
        },
        select: { docType: true, documentId: true, contentJson: true, title: true },
    });
    assertQuickActionAllowed(quickActionIdForDocType("POD") || "upload_pod", {
        status: lead.status,
        carrierName: lead.carrierName,
        carrierOnboardingStatus: lead.carrierProfileId
            ? (
                  await prisma.carrier.findUnique({
                      where: { carrierId: lead.carrierProfileId },
                      select: { onboardingStatus: true },
                  })
              )?.onboardingStatus || null
            : null,
        documents: existingDocs,
    });

    const bol = existingDocs.find((d) => d.docType === "BOL");
    if (!bol) {
        throw Object.assign(new Error("Generate BOL first — POD must be the signed copy of that BOL"), {
            status: 422,
            code: "BOL_REQUIRED",
        });
    }

    const mime = String(input.mimeType || "application/octet-stream").toLowerCase();
    const allowed =
        mime === "application/pdf" ||
        mime.startsWith("image/") ||
        /\.(pdf|png|jpe?g|webp|gif)$/i.test(input.originalName || "");
    if (!allowed) {
        throw Object.assign(new Error("Upload PDF or image of the signed BOL / POD"), { status: 400 });
    }

    const buf = fs.readFileSync(input.tempPath);
    if (!buf.length || buf.length > 15 * 1024 * 1024) {
        throw Object.assign(new Error("File empty or too large (max 15 MB)"), { status: 400 });
    }

    let bolContent: Record<string, unknown> = {};
    try {
        bolContent = bol.contentJson ? JSON.parse(bol.contentJson) : {};
    } catch {
        bolContent = {};
    }
    const bolSummary = [
        `Load ${lead.loadNumber}`,
        lead.greenOsShipmentId ? `Shipment ${lead.greenOsShipmentId}` : "",
        lead.carrierName ? `Carrier ${lead.carrierName}` : "",
        lead.carrierMc ? `MC ${lead.carrierMc}` : "",
        [lead.pickupCity, lead.pickupState].filter(Boolean).join(", "),
        "→",
        [lead.deliveryCity, lead.deliveryState].filter(Boolean).join(", "),
        bolContent.bolNumber ? `BOL# ${bolContent.bolNumber}` : "",
    ]
        .filter(Boolean)
        .join(" · ");

    let analysis: PodAnalysis;
    try {
        analysis =
            (await openaiAnalyzePod({
                buf,
                mimeType: mime.startsWith("image/") ? mime : "application/pdf",
                loadNumber: lead.loadNumber,
                bolSummary,
            })) ||
            heuristicAnalyze(buf, lead.loadNumber, Boolean(input.confirmSignature));
    } catch {
        analysis = heuristicAnalyze(buf, lead.loadNumber, Boolean(input.confirmSignature));
    }

    // If AI missed load # but filename/bytes contain it, soften match.
    if (!analysis.matchesBol) {
        const ln = lead.loadNumber.toUpperCase();
        if (
            crudePdfOrImageText(buf).toUpperCase().includes(ln) ||
            String(input.originalName || "").toUpperCase().includes(ln)
        ) {
            analysis.matchesBol = true;
            analysis.loadNumberFound = lead.loadNumber;
            analysis.analysisNotes =
                (analysis.analysisNotes || "") + " Load number found in file/name.";
        }
    }

    /*
     * Scanned PDFs often expose no useful text to the model. If the current Load
     * already has a BOL and the broker explicitly confirms the receiver mark,
     * accept the uploaded PDF/image as the signed copy. Privileged staff may also
     * approve manually with a required reason. Both paths are written to audit.
     */
    const brokerSignatureOverride =
        Boolean(input.confirmSignature) && Boolean(bol.documentId);
    if (!analysis.matchesBol && brokerSignatureOverride) {
        analysis.matchesBol = true;
        analysis.loadNumberFound = lead.loadNumber;
        analysis.analysisNotes =
            (analysis.analysisNotes || "") +
            " Broker confirmed receiver mark on uploaded BOL/POD; scanned-document match override applied.";
    }
    if (!analysis.matchesBol && manualApproval) {
        analysis.matchesBol = true;
        analysis.loadNumberFound = lead.loadNumber;
        analysis.analysisNotes =
            (analysis.analysisNotes || "") +
            ` Manually approved by ${input.actorRole}: ${manualApprovalReason}`;
    }

    if (!analysis.matchesBol) {
        throw Object.assign(
            new Error(
                `POD does not match Load/BOL ${lead.loadNumber}. Upload the signed copy of this load's BOL.`
            ),
            { status: 422, code: "POD_MISMATCH", analysis }
        );
    }

    if (!analysis.hasReceiverSignature) {
        if (input.confirmSignature || manualApproval) {
            analysis.hasReceiverSignature = true;
            analysis.analysisNotes =
                (analysis.analysisNotes || "") +
                (manualApproval
                    ? ` Receiver signature manually approved by ${input.actorRole}.`
                    : " Broker confirmed receiver mark in SIGNATURE box.");
        } else {
            throw Object.assign(
                new Error(
                    "No mark found in the SIGNATURE box (receiver must sign that cargo was received). Upload a clearer photo, or confirm the signature is visible and retry."
                ),
                { status: 422, code: "POD_NO_SIGNATURE", analysis }
            );
        }
    }

    const last = await prisma.loadDocument.findFirst({
        where: { shipmentLeadId: input.shipmentLeadId, docType: "POD" },
        orderBy: { version: "desc" },
    });
    const version = (last?.version || 0) + 1;
    if (last?.isCurrent) {
        await prisma.loadDocument.update({
            where: { documentId: last.documentId },
            data: { isCurrent: false },
        });
    }

    const dir = path.join(LOAD_DOCS_ROOT, input.shipmentLeadId);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(input.originalName || "") || (mime.includes("pdf") ? ".pdf" : ".jpg");
    const storedName = `POD_v${version}_${Date.now()}_${safeFileName(path.basename(input.originalName || `pod${ext}`))}`;
    const dest = path.join(dir, storedName);
    fs.copyFileSync(input.tempPath, dest);
    try {
        fs.unlinkSync(input.tempPath);
    } catch {
        /* ignore */
    }

    const checksum = crypto.createHash("sha256").update(buf).digest("hex");
    const content = {
        loadNumber: lead.loadNumber,
        shipmentNumber: lead.greenOsShipmentId,
        bolNumber: bolContent.bolNumber || lead.loadNumber,
        sourceBolDocumentId: bol.documentId,
        uploadedAsPod: true,
        receiverSignatureDetected: analysis.hasReceiverSignature,
        hasExceptionNotes: analysis.hasExceptionNotes,
        exceptionSummary: analysis.exceptionSummary,
        analysis,
        manuallyApproved: manualApproval,
        manualApprovalRole: manualApproval ? input.actorRole || null : null,
        manualApprovalReason: manualApproval ? manualApprovalReason : null,
        brokerSignatureOverride,
        checksum,
    };

    const title = `Proof of Delivery v${version}`;
    const row = await prisma.loadDocument.create({
        data: {
            shipmentLeadId: input.shipmentLeadId,
            docType: "POD",
            version,
            changeReason: "UPLOADED",
            title,
            status: "READY",
            isCurrent: true,
            contentJson: JSON.stringify(content),
            fileName: input.originalName || storedName,
            mimeType: mime,
            storedName,
            fileUrl: `/uploads/loads/${input.shipmentLeadId}/${storedName}`,
            fileSize: buf.length,
            createdById: input.actorUserId || null,
        },
    });

    await domainEventEngine.emit({
        shipmentLeadId: input.shipmentLeadId,
        eventType: "POD_UPLOADED",
        title: `${title} uploaded`,
        message: manualApproval
            ? `POD manually approved by ${input.actorRole}: ${manualApprovalReason}`
            : analysis.hasExceptionNotes
              ? `POD uploaded with exceptions — Team Lead notified`
              : `Signed POD verified against BOL ${lead.loadNumber}`,
        actorUserId: input.actorUserId,
        payload: {
            documentId: row.documentId,
            analysis,
            bolDocumentId: bol.documentId,
            manuallyApproved: manualApproval,
            manualApprovalRole: manualApproval ? input.actorRole || null : null,
            manualApprovalReason: manualApproval ? manualApprovalReason : null,
            brokerSignatureOverride,
        },
    });

    try {
        await shipmentService.transitionStatus({
            shipmentLeadId: input.shipmentLeadId,
            status: "POD_UPLOADED",
            actorUserId: input.actorUserId,
        });
    } catch {
        /* status may already be ahead */
    }

    let teamLeadNotify: { notified: string; userId: string | null } | null = null;
    if (analysis.hasExceptionNotes) {
        teamLeadNotify = await notifyTeamLeadOfExceptions({
            shipmentLeadId: input.shipmentLeadId,
            loadNumber: lead.loadNumber,
            brokerUserId: lead.assignedBrokerId,
            exceptionSummary: analysis.exceptionSummary,
            analysisNotes: analysis.analysisNotes,
        });
    }

    return {
        document: row,
        analysis,
        manuallyApproved: manualApproval,
        teamLeadNotified: Boolean(teamLeadNotify),
        teamLeadNotify,
    };
}

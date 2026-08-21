/**
 * Deterministic Green Logistics Document AI business rules (no OpenAI).
 */

import { normalizeMc, normalizeMoney, normalizeName } from "./normalize.js";

export const GL_RULES = {
    AUTO_LIABILITY_MIN: 1_000_000,
    CARGO_MIN: 100_000,
    GL_MIN: 1_000_000,
    EL_MIN: 500_000,
    CERTIFICATE_HOLDER: "GREEN LOGISTICS LLC",
    BROKER_MC: "1237784",
} as const;

export type RuleCheck = {
    id: string;
    ok: boolean;
    status:
        | "PASS"
        | "FAIL"
        | "MISSING"
        | "UNCERTAIN"
        | "BELOW_REQUIREMENT"
        | "EXPIRED"
        | "MISMATCH"
        | "CRITICAL_MISMATCH"
        | "SKIPPED";
    message: string;
    documentValue?: string | null;
    requiredValue?: string | null;
    greenOsValue?: string | null;
};

export function checkMoneyMin(
    id: string,
    label: string,
    raw: string | number | null | undefined,
    min: number
): RuleCheck {
    if (raw == null || raw === "") {
        return {
            id,
            ok: false,
            status: "MISSING",
            message: `${label} missing`,
            requiredValue: String(min),
        };
    }
    const n = typeof raw === "number" ? raw : normalizeMoney(String(raw));
    if (n == null) {
        return {
            id,
            ok: false,
            status: "UNCERTAIN",
            message: `${label} unreadable`,
            documentValue: String(raw),
            requiredValue: String(min),
        };
    }
    if (n < min) {
        return {
            id,
            ok: false,
            status: "BELOW_REQUIREMENT",
            message: `${label} $${n} below required $${min}`,
            documentValue: String(n),
            requiredValue: String(min),
        };
    }
    return {
        id,
        ok: true,
        status: "PASS",
        message: `${label} meets minimum`,
        documentValue: String(n),
        requiredValue: String(min),
    };
}

export function checkCertificateHolder(raw: string | null | undefined): RuleCheck {
    const n = normalizeName(raw);
    const want = normalizeName(GL_RULES.CERTIFICATE_HOLDER);
    if (!n) {
        return {
            id: "BR-INS-HOLDER",
            ok: false,
            status: "MISSING",
            message: "Certificate holder missing",
            requiredValue: GL_RULES.CERTIFICATE_HOLDER,
        };
    }
    if (n === want || (n.includes("GREEN LOGISTICS") && n.includes("LLC"))) {
        return {
            id: "BR-INS-HOLDER",
            ok: true,
            status: "PASS",
            message: "Certificate holder matches Green Logistics",
            documentValue: raw || null,
            requiredValue: GL_RULES.CERTIFICATE_HOLDER,
        };
    }
    return {
        id: "BR-INS-HOLDER",
        ok: false,
        status: "MISMATCH",
        message: "Certificate holder is not GREEN LOGISTICS LLC",
        documentValue: raw || null,
        requiredValue: GL_RULES.CERTIFICATE_HOLDER,
    };
}

export function checkExpired(policyExp: string | null | undefined, now = new Date()): RuleCheck {
    if (!policyExp) {
        return {
            id: "BR-INS-EXP",
            ok: false,
            status: "UNCERTAIN",
            message: "Policy expiration missing/uncertain",
        };
    }
    const d = Date.parse(policyExp);
    if (!Number.isFinite(d)) {
        // try MM/DD/YYYY
        const m = String(policyExp).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        if (!m) {
            return {
                id: "BR-INS-EXP",
                ok: false,
                status: "UNCERTAIN",
                message: "Policy expiration unreadable",
                documentValue: policyExp,
            };
        }
        const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
        const dt = new Date(year, Number(m[1]) - 1, Number(m[2]));
        if (dt.getTime() < now.getTime()) {
            return {
                id: "BR-INS-EXP",
                ok: false,
                status: "EXPIRED",
                message: "Insurance policy expired",
                documentValue: policyExp,
            };
        }
        return {
            id: "BR-INS-EXP",
            ok: true,
            status: "PASS",
            message: "Insurance not expired",
            documentValue: policyExp,
        };
    }
    if (d < now.getTime()) {
        return {
            id: "BR-INS-EXP",
            ok: false,
            status: "EXPIRED",
            message: "Insurance policy expired",
            documentValue: policyExp,
        };
    }
    return {
        id: "BR-INS-EXP",
        ok: true,
        status: "PASS",
        message: "Insurance not expired",
        documentValue: policyExp,
    };
}

export function checkExactId(
    id: string,
    label: string,
    documentRaw: string | null | undefined,
    greenOsRaw: string | null | undefined,
    normalize: (v: string | null | undefined) => string | null
): RuleCheck {
    const doc = normalize(documentRaw);
    const gos = normalize(greenOsRaw);
    if (!doc) {
        return {
            id,
            ok: false,
            status: "MISSING",
            message: `${label} missing on document`,
            greenOsValue: greenOsRaw || null,
        };
    }
    if (!gos) {
        return {
            id,
            ok: true,
            status: "PASS",
            message: `${label} present; GreenOS empty (no mismatch)`,
            documentValue: doc,
        };
    }
    if (doc !== gos) {
        return {
            id,
            ok: false,
            status: "CRITICAL_MISMATCH",
            message: `${label} document ≠ GreenOS`,
            documentValue: doc,
            greenOsValue: gos,
        };
    }
    return {
        id,
        ok: true,
        status: "PASS",
        message: `${label} matches GreenOS`,
        documentValue: doc,
        greenOsValue: gos,
    };
}

export function checkBrokerMc(documentRaw: string | null | undefined): RuleCheck {
    const doc = normalizeMc(documentRaw);
    if (!doc) {
        return {
            id: "BR-BROKER-MC",
            ok: false,
            status: "MISSING",
            message: "Broker MC missing",
            requiredValue: GL_RULES.BROKER_MC,
        };
    }
    if (doc !== GL_RULES.BROKER_MC) {
        return {
            id: "BR-BROKER-MC",
            ok: false,
            status: "MISMATCH",
            message: "Broker MC is not Green Logistics 1237784",
            documentValue: doc,
            requiredValue: GL_RULES.BROKER_MC,
        };
    }
    return {
        id: "BR-BROKER-MC",
        ok: true,
        status: "PASS",
        message: "Broker MC matches Green Logistics",
        documentValue: doc,
    };
}

export function evaluateInsuranceRules(fields: Record<string, string | number | null | undefined>): RuleCheck[] {
    return [
        checkMoneyMin("BR-INS-AUTO", "Auto Liability", fields.autoLiabilityLimit, GL_RULES.AUTO_LIABILITY_MIN),
        checkMoneyMin("BR-INS-CARGO", "Motor Truck Cargo", fields.cargoLimit, GL_RULES.CARGO_MIN),
        checkMoneyMin("BR-INS-GL", "General Liability", fields.glLimit, GL_RULES.GL_MIN),
        fields.elLimit != null && fields.elLimit !== ""
            ? checkMoneyMin("BR-INS-EL", "Employer Liability", fields.elLimit, GL_RULES.EL_MIN)
            : {
                  id: "BR-INS-EL",
                  ok: true,
                  status: "SKIPPED",
                  message: "Employer Liability not present on document",
              },
        checkCertificateHolder(
            fields.certificateHolder != null ? String(fields.certificateHolder) : null
        ),
        checkExpired(fields.policyExp != null ? String(fields.policyExp) : null),
    ];
}

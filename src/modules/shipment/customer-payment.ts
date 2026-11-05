/** How the customer pays a load. Four methods add 3% on top of the customer rate. */

export const CUSTOMER_PAYMENT_METHODS = [
    { id: "WIRE", label: "Wire", feeRate: 0 },
    { id: "VENMO", label: "Venmo +3%", feeRate: 0.03 },
    { id: "PAYPAL", label: "PayPal +3%", feeRate: 0.03 },
    { id: "CREDIT_CARD", label: "Credit card +3%", feeRate: 0.03 },
    { id: "CASHAPP", label: "Cash App +3%", feeRate: 0.03 },
    { id: "ZELLE", label: "Zelle", feeRate: 0 },
    { id: "ACH", label: "ACH", feeRate: 0 },
] as const;

export type CustomerPaymentMethodId = (typeof CUSTOMER_PAYMENT_METHODS)[number]["id"];

const BY_ID = new Map(CUSTOMER_PAYMENT_METHODS.map((row) => [row.id, row]));

export function normalizeCustomerPaymentMethod(value: unknown): CustomerPaymentMethodId | null {
    const key = String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
    if (key === "CREDIT" || key === "CARD" || key === "CREDITCARD") return "CREDIT_CARD";
    if (key === "CASH_APP") return "CASHAPP";
    return BY_ID.has(key as CustomerPaymentMethodId) ? (key as CustomerPaymentMethodId) : null;
}

function money(value: unknown): number {
    if (value == null || value === "") return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function hasAmount(value: unknown): boolean {
    if (value == null || value === "") return false;
    return Number.isFinite(typeof value === "number" ? value : Number(value));
}

function cents(value: number): number {
    return Math.round(value * 100) / 100;
}

export type CustomerPaymentQuote = {
    method: CustomerPaymentMethodId | null;
    label: string | null;
    feeRate: number;
    fee: number;
    waived: boolean;
    rate: number | null;
    accessorials: number;
    /** Rate + accessorials + the 3% fee, unless Accounting waived the fee. */
    total: number | null;
};

export function customerPaymentQuote(input: {
    customerRate?: unknown;
    accessorialCharges?: unknown;
    method?: unknown;
    waiveFee?: boolean | null;
}): CustomerPaymentQuote {
    const methodId = normalizeCustomerPaymentMethod(input.method);
    const method = methodId ? BY_ID.get(methodId)! : null;
    const knownRate = hasAmount(input.customerRate);
    const rate = knownRate ? money(input.customerRate) : null;
    const accessorials = money(input.accessorialCharges);
    const feeRate = method && !input.waiveFee ? method.feeRate : 0;
    const fee = rate == null ? 0 : cents(rate * feeRate);
    const total = rate == null && !accessorials ? null : cents((rate || 0) + accessorials + fee);
    return {
        method: methodId,
        label: method ? (input.waiveFee ? method.label.replace(/ \+3%$/, "") : method.label) : null,
        feeRate,
        fee,
        waived: Boolean(input.waiveFee && method && method.feeRate > 0),
        rate,
        accessorials,
        total,
    };
}

export function canWaiveCustomerPaymentFee(role: string | null | undefined): boolean {
    return (
        role === "Accounting" ||
        role === "Owner" ||
        role === "Manager" ||
        role === "Administrator"
    );
}

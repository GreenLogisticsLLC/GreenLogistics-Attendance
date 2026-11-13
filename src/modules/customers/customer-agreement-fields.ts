import type { CustomerAgreementType } from "./customer-agreement.js";
export {
    customerAgreementSections,
    customerAgreementTerms,
    type CustomerAgreementSection,
} from "./customer-agreement-content.js";

export type AgreementFieldDef = {
    key: string;
    label: string;
    section: string;
    multiline?: boolean;
    /** When set, portal renders a <select> instead of a free-text input. */
    options?: string[];
};

export const PAYMENT_SCHEDULE_SPLIT_50_50 = "50% / 50% (pickup + delivery)";
export const PAYMENT_SCHEDULE_FULL_AFTER_PICKUP = "Full payment after pickup";
export const PAYMENT_SCHEDULE_OPTIONS = [
    PAYMENT_SCHEDULE_SPLIT_50_50,
    PAYMENT_SCHEDULE_FULL_AFTER_PICKUP,
] as const;

export function customerAgreementFields(type: CustomerAgreementType): AgreementFieldDef[] {
    if (type === "LONG_TIME") {
        return [
            { key: "legalCompanyName", label: "Legal Company Name", section: "Customer information" },
            { key: "businessType", label: "Business Type", section: "Customer information" },
            {
                key: "authorizedRepresentative",
                label: "Authorized Representative",
                section: "Customer information",
            },
            { key: "title", label: "Title", section: "Customer information" },
            { key: "businessAddress", label: "Business Address", section: "Customer information" },
            { key: "cityStateZip", label: "City, State, ZIP", section: "Customer information" },
            { key: "email", label: "Email Address", section: "Customer information" },
            { key: "phone", label: "Phone Number", section: "Customer information" },
            { key: "billingContact", label: "Billing Contact", section: "Customer information" },
            {
                key: "accountsPayableEmail",
                label: "Accounts Payable Email",
                section: "Customer information",
            },
            {
                key: "customerCompanySign",
                label: "Legal Company Name (signature block)",
                section: "Customer signature",
            },
            {
                key: "customerRepSign",
                label: "Authorized Representative (signature block)",
                section: "Customer signature",
            },
            { key: "customerTitleSign", label: "Title (signature block)", section: "Customer signature" },
        ];
    }
    return [
        { key: "fullLegalName", label: "Full Legal Name", section: "Customer information" },
        { key: "companyName", label: "Company Name (if applicable)", section: "Customer information" },
        { key: "businessAddress", label: "Business Address", section: "Customer information" },
        { key: "cityStateZip", label: "City, State, ZIP", section: "Customer information" },
        { key: "email", label: "Email Address", section: "Customer information" },
        { key: "phone", label: "Phone Number", section: "Customer information" },
        {
            key: "shipmentRef",
            label: "Shipment / Booking Reference",
            section: "Shipment information",
        },
        { key: "commodity", label: "Commodity Description", section: "Shipment information" },
        { key: "quantity", label: "Quantity", section: "Shipment information" },
        { key: "totalWeight", label: "Total Weight", section: "Shipment information" },
        { key: "dimensions", label: "Dimensions", section: "Shipment information" },
        { key: "pickupAddress", label: "Pickup Address", section: "Shipment information" },
        { key: "pickupDateTime", label: "Pickup Date / Time", section: "Shipment information" },
        { key: "deliveryAddress", label: "Delivery Address", section: "Shipment information" },
        { key: "deliveryDateTime", label: "Delivery Date / Time", section: "Shipment information" },
        { key: "equipment", label: "Equipment Required", section: "Shipment information" },
        { key: "loadingRequirements", label: "Loading Requirements", section: "Shipment information" },
        {
            key: "unloadingRequirements",
            label: "Unloading Requirements",
            section: "Shipment information",
        },
        {
            key: "additionalInstructions",
            label: "Additional Instructions",
            section: "Shipment information",
            multiline: true,
        },
        {
            key: "totalCharge",
            label: "Total Agreed Transportation Charge (USD)",
            section: "Price and payment",
        },
        { key: "paymentMethod", label: "Payment Method", section: "Price and payment" },
        {
            key: "paymentSchedule",
            label: "Payment Schedule",
            section: "Price and payment",
            options: [...PAYMENT_SCHEDULE_OPTIONS],
        },
        { key: "firstPayment", label: "First Payment (USD)", section: "Price and payment" },
        { key: "finalPayment", label: "Final Payment (USD)", section: "Price and payment" },
        { key: "customerFullName", label: "Full Name (signature block)", section: "Customer signature" },
        { key: "customerCompany", label: "Company (signature block)", section: "Customer signature" },
    ];
}

export function customerAgreementTitle(type: CustomerAgreementType): string {
    return type === "LONG_TIME"
        ? "MASTER CUSTOMER–BROKER AGREEMENT"
        : "CUSTOMER–BROKER AGREEMENT";
}

export function customerAgreementSubtitle(type: CustomerAgreementType): string {
    return type === "LONG_TIME"
        ? "Long-Term Transportation and Brokerage Services Agreement"
        : "Individual Shipment Agreement";
}

export type CustomerAgreementShipmentPrefill = {
    loadNumber?: string | null;
    greenOsShipmentId?: string | null;
    shipmentTitle?: string | null;
    commodity?: string | null;
    pieces?: number | string | null;
    weight?: string | null;
    equipment?: string | null;
    specialInstructions?: string | null;
    pickupCity?: string | null;
    pickupState?: string | null;
    pickupZip?: string | null;
    deliveryCity?: string | null;
    deliveryState?: string | null;
    deliveryZip?: string | null;
    pickupFrom?: Date | string | null;
    deliveryFrom?: Date | string | null;
    customerRate?: number | string | null;
    price?: number | string | null;
    customerPaymentMethod?: string | null;
    customerPaymentLabel?: string | null;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
};

/** Always prefix with $ when a positive amount is present. */
export function fmtMoney(value: unknown): string {
    const raw = String(value ?? "")
        .trim()
        .replace(/^\$/, "")
        .replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n === 0) return "$0";
    const body = n % 1 === 0 ? String(n) : n.toFixed(2);
    return `$${body}`;
}

/** Split total into first/final amounts for the chosen payment schedule. */
export function paymentAmountsForSchedule(
    totalRaw: unknown,
    scheduleRaw?: string | null
): { firstPayment: string; finalPayment: string; paymentSchedule: string } {
    const total = fmtMoney(totalRaw);
    const schedule = String(scheduleRaw || "").trim() || PAYMENT_SCHEDULE_SPLIT_50_50;
    const isFullAfterPickup =
        schedule === PAYMENT_SCHEDULE_FULL_AFTER_PICKUP ||
        /full\s*payment\s*after\s*pickup/i.test(schedule);
    if (!total) {
        return {
            paymentSchedule: isFullAfterPickup
                ? PAYMENT_SCHEDULE_FULL_AFTER_PICKUP
                : PAYMENT_SCHEDULE_SPLIT_50_50,
            firstPayment: "",
            finalPayment: "",
        };
    }
    if (isFullAfterPickup) {
        return {
            paymentSchedule: PAYMENT_SCHEDULE_FULL_AFTER_PICKUP,
            firstPayment: "$0",
            finalPayment: total,
        };
    }
    const n = Number(String(total).replace(/^\$/, ""));
    const half = fmtMoney(n / 2);
    return {
        paymentSchedule: PAYMENT_SCHEDULE_SPLIT_50_50,
        firstPayment: half,
        finalPayment: half,
    };
}

function fmtPlace(city?: string | null, state?: string | null, zip?: string | null): string {
    const cityState = [String(city || "").trim(), String(state || "").trim().toUpperCase()]
        .filter(Boolean)
        .join(", ");
    return [cityState, String(zip || "").trim()].filter(Boolean).join(" ").trim();
}

function fmtDateTime(value?: Date | string | null, timezone = "America/Los_Angeles"): string {
    if (!value) return "";
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).trim();
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        }).format(d);
    } catch {
        return d.toISOString().slice(0, 16).replace("T", " ");
    }
}

/** Merge only non-empty values; never overwrite a filled key with blank. */
export function mergeAgreementFields(
    base: Record<string, string>,
    extra: Record<string, string | null | undefined>
): Record<string, string> {
    const out = { ...base };
    for (const [key, raw] of Object.entries(extra)) {
        const val = String(raw ?? "").trim();
        if (!val) continue;
        if (!String(out[key] || "").trim()) out[key] = val;
    }
    return out;
}

export function prefillCustomerAgreementFields(input: {
    agreementType: CustomerAgreementType;
    companyName?: string | null;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    billingAddress?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    shipment?: CustomerAgreementShipmentPrefill | null;
    timezone?: string;
}): Record<string, string> {
    const cityStateZip = [input.city, input.state, input.zip].filter(Boolean).join(", ");
    const addr = String(input.billingAddress || "").trim();
    const ship = input.shipment || null;
    const timezone = input.timezone || "America/Los_Angeles";

    if (input.agreementType === "LONG_TIME") {
        return mergeAgreementFields(
            {
                legalCompanyName: String(input.companyName || ship?.customerName || ""),
                authorizedRepresentative: String(input.contactName || ""),
                businessAddress: addr,
                cityStateZip,
                email: String(input.email || ship?.customerEmail || ""),
                phone: String(input.phone || ship?.customerPhone || ""),
                customerCompanySign: String(input.companyName || ship?.customerName || ""),
                customerRepSign: String(input.contactName || ""),
            },
            {}
        );
    }

    const total = fmtMoney(ship?.customerRate ?? ship?.price);
    const payParts = paymentAmountsForSchedule(total, PAYMENT_SCHEDULE_SPLIT_50_50);
    const payment =
        String(ship?.customerPaymentLabel || "").trim() ||
        String(ship?.customerPaymentMethod || "").trim();

    return mergeAgreementFields(
        {
            fullLegalName: String(input.contactName || input.companyName || ship?.customerName || ""),
            companyName: String(input.companyName || ship?.customerName || ""),
            businessAddress: addr,
            cityStateZip,
            email: String(input.email || ship?.customerEmail || ""),
            phone: String(input.phone || ship?.customerPhone || ""),
            customerFullName: String(input.contactName || ship?.customerName || ""),
            customerCompany: String(input.companyName || ship?.customerName || ""),
        },
        {
            shipmentRef: String(ship?.loadNumber || ship?.greenOsShipmentId || "").trim(),
            commodity: String(ship?.commodity || ship?.shipmentTitle || "").trim(),
            quantity:
                ship?.pieces == null || ship?.pieces === ""
                    ? ""
                    : String(ship.pieces),
            totalWeight: String(ship?.weight || "").trim(),
            pickupAddress: fmtPlace(ship?.pickupCity, ship?.pickupState, ship?.pickupZip),
            pickupDateTime: fmtDateTime(ship?.pickupFrom, timezone),
            deliveryAddress: fmtPlace(ship?.deliveryCity, ship?.deliveryState, ship?.deliveryZip),
            deliveryDateTime: fmtDateTime(ship?.deliveryFrom, timezone),
            equipment: String(ship?.equipment || "").trim(),
            additionalInstructions: String(ship?.specialInstructions || "").trim(),
            totalCharge: total,
            paymentMethod: payment,
            paymentSchedule: payParts.paymentSchedule,
            firstPayment: payParts.firstPayment,
            finalPayment: payParts.finalPayment,
        }
    );
}

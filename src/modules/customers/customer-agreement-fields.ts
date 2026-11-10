import type { CustomerAgreementType } from "./customer-agreement.js";

export type AgreementFieldDef = {
    key: string;
    label: string;
    section: string;
    multiline?: boolean;
};

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
        { key: "firstPayment", label: "First Payment 50% (USD)", section: "Price and payment" },
        { key: "finalPayment", label: "Final Payment 50% (USD)", section: "Price and payment" },
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

/** Condensed operative terms shown above the signature blocks. */
export function customerAgreementTerms(type: CustomerAgreementType): string[] {
    if (type === "LONG_TIME") {
        return [
            "Green Logistics LLC is a licensed property transportation broker (FMCSA MC #1237784) and arranges transportation through authorized third-party motor carriers.",
            "This Master Agreement remains in effect for one (1) year from the Effective Date and renews automatically unless terminated with thirty (30) days’ written notice.",
            "Each shipment will be confirmed separately (rate, commodity, equipment, pickup/delivery, and payment). Broker does not operate as the motor carrier.",
            "Customer warrants shipment information is accurate and complete. Accessorial charges (TONU, detention, driver assist, etc.) apply only when disclosed and agreed.",
            "Electronic signatures and electronic records have the same legal effect as handwritten signatures where permitted by law.",
            "By signing, both parties acknowledge they have read, understood, and agreed to this Master Customer–Broker Agreement.",
        ];
    }
    return [
        "Green Logistics LLC is a licensed property transportation broker (FMCSA MC #1237784) arranging transportation through an authorized third-party motor carrier.",
        "Broker coordinates the shipment and uses reasonable care selecting a carrier; Broker is not the motor carrier physically transporting the freight.",
        "Customer warrants all shipment information is accurate and complete, and agrees to the transportation price and payment schedule confirmed for this shipment.",
        "Payment may be direct (Zelle, Venmo, Cash App, PayPal, bank transfer, etc.) or via uShip Payments when applicable. No uShip payment code may be requested before delivery.",
        "Electronic signatures have the same legal effect as handwritten signatures where permitted by applicable law.",
        "By signing below, Customer confirms: shipment information is accurate; price reviewed and accepted; payment method/schedule confirmed; Terms & Conditions reviewed; and Customer has authority to enter this Agreement.",
    ];
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
}): Record<string, string> {
    const cityStateZip = [input.city, input.state, input.zip].filter(Boolean).join(", ");
    const addr = String(input.billingAddress || "").trim();
    if (input.agreementType === "LONG_TIME") {
        return {
            legalCompanyName: String(input.companyName || ""),
            authorizedRepresentative: String(input.contactName || ""),
            businessAddress: addr,
            cityStateZip,
            email: String(input.email || ""),
            phone: String(input.phone || ""),
            customerCompanySign: String(input.companyName || ""),
            customerRepSign: String(input.contactName || ""),
        };
    }
    return {
        fullLegalName: String(input.contactName || input.companyName || ""),
        companyName: String(input.companyName || ""),
        businessAddress: addr,
        cityStateZip,
        email: String(input.email || ""),
        phone: String(input.phone || ""),
        customerFullName: String(input.contactName || ""),
        customerCompany: String(input.companyName || ""),
    };
}

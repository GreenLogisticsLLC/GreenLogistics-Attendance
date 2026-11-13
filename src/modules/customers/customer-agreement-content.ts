import type { CustomerAgreementType } from "./customer-agreement.js";

/** One titled block of operative agreement text (from Broker Customer *.docx). */
export type CustomerAgreementSection = {
    title: string;
    lines: string[];
};

const LONG_TIME_SECTIONS: CustomerAgreementSection[] = [
    {
        title: "Introduction",
        lines: [
            'This Master Customer–Broker Agreement ("Agreement") is entered into between Green Logistics LLC ("Broker") and the customer identified below ("Customer").',
            "Agreement Term: One (1) year from the Effective Date, automatically renewing for successive one-year periods unless terminated in accordance with this Agreement.",
            "Green Logistics LLC is a licensed property transportation broker operating under FMCSA Broker Authority MC #1237784.",
            "The parties agree as follows:",
        ],
    },
    {
        title: "2. Purpose and Scope of Agreement",
        lines: [
            "2.1. Broker agrees to arrange transportation services for Customer through properly authorized and appropriately insured third-party motor carriers.",
            "2.2. Services may include full truckload (FTL), less-than-truckload (LTL), flatbed, step-deck, lowboy, RGN, box truck, power-only, heavy equipment, and other mutually agreed transportation services.",
            "2.3. Broker will coordinate transportation arrangements, communicate shipment information, monitor shipment progress to the extent reasonably available, and assist with operational issues.",
            "2.4. Broker operates as an independent transportation broker and does not personally operate the equipment or physically transport Customer's freight.",
            "2.5. Each shipment tendered under this Agreement will be subject to a separate written Rate Confirmation or Shipment Confirmation accepted by the parties.",
        ],
    },
    {
        title: "3. Term and Termination",
        lines: [
            "3.1. This Agreement shall remain in effect for one (1) year from its Effective Date.",
            "3.2. The Agreement will automatically renew for successive one-year periods unless either party provides thirty (30) days' written notice of termination.",
            "3.3. Either party may terminate this Agreement immediately upon written notice if the other party materially breaches this Agreement and fails to remedy the breach within ten (10) business days after receiving written notice, where the breach is capable of remedy.",
            "3.4. Either party may terminate immediately if the other party becomes insolvent, ceases operations, or loses an essential license or authority required to perform its obligations.",
            "3.5. Termination will not eliminate payment obligations, accrued liabilities, or responsibilities relating to shipments already accepted or in progress.",
        ],
    },
    {
        title: "4. Shipment Orders and Rate Confirmations",
        lines: [
            "4.1. Customer may request transportation services by email, telephone, or another mutually approved written communication method.",
            "4.2. Before dispatch, the parties shall confirm the applicable shipment details, including: Pickup and delivery locations; Commodity and shipment description; Quantity, weight, and dimensions; Required transportation equipment; Pickup and delivery dates; Total agreed transportation price; Payment method and payment schedule; Special instructions and additional services.",
            "4.3. Each shipment shall be documented through a written Rate Confirmation, Shipment Confirmation, or other mutually accepted written order.",
            "4.4. No shipment shall be considered accepted for dispatch until the applicable rate and material shipment requirements have been confirmed.",
            "4.5. If a shipment-specific confirmation conflicts with this Master Agreement, the shipment-specific confirmation shall control only with respect to that particular shipment, provided that it expressly identifies the provision being modified and is accepted by both parties.",
            "4.6. All shipment confirmations are incorporated into and governed by this Master Agreement.",
        ],
    },
    {
        title: "5. Transportation Rates and Payment Terms",
        lines: [
            "5.1. Transportation rates shall be agreed upon separately for each shipment and confirmed in writing before dispatch.",
            "5.2. Unless a different arrangement is expressly agreed upon in the applicable Rate Confirmation, the standard payment schedule for direct-payment shipments shall be: 50% upon pickup — due immediately after the shipment has been picked up and loaded; 50% upon delivery — due upon delivery and before unloading where legally permissible and agreed in the shipment confirmation.",
            "5.3. Customer may use an agreed payment method, including Zelle, Venmo, Cash App, PayPal, bank transfer, or another mutually accepted payment method, for direct-payment shipments.",
            "5.4. All payment arrangements must be confirmed before dispatch.",
            "5.5. For uShip transactions, the applicable uShip payment method and mandatory payment procedures shall control.",
            "5.6. Customer agrees to pay all transportation charges and approved additional costs in accordance with the applicable shipment confirmation.",
            "5.7. Customer shall not withhold undisputed transportation charges solely because a separate cargo damage, shortage, or insurance claim is pending, subject to applicable law and any mandatory payment rights.",
            "5.8. For approved invoicing arrangements, payment shall be due within the period stated in the applicable Rate Confirmation or written credit terms.",
            "5.9. Overdue amounts may be subject to lawful interest, collection costs, and reasonable attorney fees where permitted by law and awarded or otherwise recoverable.",
        ],
    },
    {
        title: "6. Customer's Responsibilities",
        lines: [
            "6.1. Customer shall provide complete and accurate shipment information.",
            "6.2. Customer shall disclose all material shipment characteristics, including dimensions, weight, quantity, commodity type, packaging, hazardous materials, and handling requirements.",
            "6.3. Customer shall ensure that freight is properly packaged, secured, and ready for pickup.",
            "6.4. Customer shall ensure that pickup and delivery locations are accessible to the agreed transportation equipment.",
            "6.5. Customer shall provide appropriate loading and unloading facilities or disclose any required assistance before dispatch.",
            "6.6. Customer shall provide accurate pickup and delivery contact information.",
            "6.7. Customer shall ensure that any person signing a shipment confirmation or accepting delivery has the appropriate authority.",
            "6.8. Customer shall promptly notify Broker of any changes affecting shipment availability, scheduling, equipment, or delivery requirements.",
        ],
    },
    {
        title: "7. Rate Adjustments and Additional Charges",
        lines: [
            "7.1. Agreed transportation rates are based on the shipment information provided by Customer.",
            "7.2. Additional charges may apply when the actual shipment or required services materially differ from the confirmed booking.",
            "7.3. Such circumstances may include: Incorrect dimensions, weight, or quantity; Additional freight not originally disclosed; Different equipment requirements; Inaccessible pickup or delivery locations; Additional loading or unloading assistance; Detention beyond the agreed free time; Re-delivery or rescheduling; Storage or additional handling; Customer-requested changes after dispatch.",
            "7.4. Broker shall provide written notice of proposed additional charges and obtain Customer's written approval before the additional service is performed, except where otherwise permitted by applicable law.",
            "7.5. Unless otherwise agreed in the shipment confirmation, the following standard charges may apply: Truck Ordered but Not Used — $200 when dispatch has occurred and the failure to load is attributable to Customer; Detention — first two hours free, $50 per additional hour; Driver Assistance — $150–$500 depending on the scope of the requested work, with the exact amount approved in advance.",
            "7.6. All approved additional charges shall be documented in writing and included in the applicable shipment invoice.",
        ],
    },
    {
        title: "8. Carrier Selection and Transportation",
        lines: [
            "8.1. Broker will use reasonable care in selecting and arranging transportation through authorized motor carriers.",
            "8.2. Broker will make reasonable efforts to verify the carrier's operating authority and applicable insurance before tendering a shipment.",
            "8.3. The actual carrier is responsible for operating its equipment, employing or engaging its drivers, and performing the physical transportation.",
            "8.4. Broker will not knowingly arrange transportation through a carrier lacking the operating authority required for the shipment.",
            "8.5. Any substitution of the contracted motor carrier must be communicated to Customer and must comply with applicable law and platform requirements. Where express consent is required, transportation shall not be reassigned without that consent.",
            "8.6. Broker will not knowingly authorize unauthorized double brokering or unauthorized re-brokering of a shipment.",
        ],
    },
    {
        title: "9. Insurance and Cargo Claims",
        lines: [
            "9.1. Customer acknowledges that Broker is a transportation broker and does not itself provide the motor carrier's cargo insurance.",
            "9.2. Broker will make reasonable efforts to arrange transportation through carriers maintaining applicable insurance coverage.",
            "9.3. Specific insurance limits and coverage are subject to verification and the actual insurance policy, including exclusions, deductibles, conditions, and limitations.",
            "9.4. Customer shall disclose the actual and declared value of the freight before dispatch, particularly for high-value shipments.",
            "9.5. Any special cargo insurance requirements or additional coverage must be agreed upon in writing before dispatch.",
            "9.6. Customer shall promptly notify Broker and the responsible carrier of any cargo loss, shortage, or damage.",
            "9.7. Visible damage or shortage should be documented on the delivery receipt or BOL at the time of delivery whenever reasonably possible.",
            "9.8. Customer shall preserve relevant evidence, including photographs, packaging, inspection records, invoices, repair estimates, and delivery documents.",
            "9.9. Formal cargo claims must be submitted in writing to the responsible carrier in accordance with applicable federal law and the applicable transportation documents.",
            "9.10. Broker will reasonably assist Customer in coordinating communications and providing available shipment documentation to the carrier or insurer.",
            "9.11. The responsible carrier and/or insurer will investigate and determine coverage and payment under applicable law and the insurance policy.",
            "9.12. Broker does not guarantee claim approval, insurance reimbursement, or a particular settlement amount.",
            "9.13. Nothing in this Agreement shall waive any liability or legal remedy that cannot legally be waived.",
        ],
    },
    {
        title: "10. Pickup, Delivery, and Delays",
        lines: [
            "10.1. Pickup and delivery dates and times are estimates unless a firm appointment is expressly guaranteed in writing.",
            "10.2. Broker will make reasonable efforts to coordinate shipment schedules and communicate material delays.",
            "10.3. Delays may result from weather, traffic, road restrictions, accidents, mechanical problems, government restrictions, carrier availability, or other circumstances beyond reasonable control.",
            "10.4. Broker shall not be responsible for indirect or consequential losses arising from delays except to the extent imposed by applicable law or expressly accepted in writing.",
        ],
    },
    {
        title: "11. Cancellations and Service Changes",
        lines: [
            "11.1. Either party shall promptly communicate any requested cancellation or rescheduling.",
            "11.2. Customer may be responsible for reasonable and documented transportation-related expenses resulting from cancellation or changes after dispatch where attributable to Customer.",
            "11.3. If a shipment has already been dispatched, Broker will communicate any applicable cancellation or truck-not-used charges before they are invoiced.",
            "11.4. Shipments booked through uShip remain subject to uShip's cancellation and dispute procedures.",
            "11.5. A cancellation shall not eliminate any payment obligations already incurred.",
        ],
    },
    {
        title: "12. Indemnification",
        lines: [
            "12.1. Each party shall be responsible for its own negligence, willful misconduct, violations of applicable law, and material breach of this Agreement.",
            "12.2. Customer shall be responsible for claims or additional expenses to the extent caused by inaccurate shipment information, undisclosed hazardous materials, improper packaging, or Customer's failure to satisfy agreed shipment requirements.",
            "12.3. Neither party shall be required to indemnify the other for the other party's own negligence, willful misconduct, or unlawful conduct.",
            "12.4. Nothing in this section limits rights or liabilities that cannot legally be limited.",
        ],
    },
    {
        title: "13. Confidentiality",
        lines: [
            "13.1. Both parties agree to protect confidential business information, including negotiated transportation rates, customer information, shipment details, operational procedures, and other proprietary information.",
            "13.2. Confidential information shall not be disclosed to unauthorized third parties except where required by law, necessary to arrange or perform transportation, or authorized in writing.",
            "13.3. This obligation shall continue after termination of this Agreement.",
        ],
    },
    {
        title: "14. Independent Contractor Relationship",
        lines: [
            "14.1. Broker is an independent contractor and not an employee, partner, or joint venture of Customer.",
            "14.2. The motor carriers arranged by Broker are independent transportation providers.",
            "14.3. Nothing in this Agreement creates an employment relationship between Customer and Broker's personnel or the motor carriers' drivers.",
        ],
    },
    {
        title: "15. Force Majeure",
        lines: [
            "Neither party shall be responsible for a failure or delay in performing its obligations to the extent caused by circumstances beyond its reasonable control, including natural disasters, severe weather, war, government orders, labor disruptions, or major transportation infrastructure interruptions.",
            "The affected party shall notify the other party as soon as reasonably practicable and make reasonable efforts to mitigate the effects.",
            "This provision does not excuse payment obligations for services already performed or amounts otherwise due.",
        ],
    },
    {
        title: "16. Notices and Communications",
        lines: [
            "16.1. Official notices may be sent to the email addresses identified in this Agreement or subsequently updated in writing.",
            "16.2. Shipment-specific instructions and approvals may be communicated through mutually accepted email or electronic messaging channels.",
            "16.3. Each party shall promptly notify the other of changes to its contact or billing information.",
        ],
    },
    {
        title: "17. Governing Law and Dispute Resolution",
        lines: [
            "17.1. This Agreement shall be governed by applicable federal transportation law and, where not preempted, the laws of the Commonwealth of Pennsylvania.",
            "17.2. Disputes shall be submitted to a court of competent jurisdiction in Pennsylvania, subject to applicable jurisdiction and venue requirements.",
            "17.3. The parties shall make reasonable efforts to resolve disputes through written communication and good-faith negotiations before commencing legal proceedings.",
        ],
    },
    {
        title: "18. Electronic Signatures",
        lines: [
            "18.1. The parties agree that electronic records and electronic signatures may be used to execute this Agreement and individual shipment confirmations.",
            "18.2. Electronic signatures shall have the same legal effect as handwritten signatures where permitted by applicable law.",
            "18.3. Copies of signed documents transmitted electronically shall be treated as valid counterparts.",
        ],
    },
    {
        title: "19. Entire Agreement and Severability",
        lines: [
            "19.1. This Agreement constitutes the general contractual understanding between the parties concerning brokerage services.",
            "19.2. Individual shipment confirmations and mutually approved amendments shall form part of this Agreement.",
            "19.3. Any amendments to this Agreement must be made in writing and accepted by authorized representatives of both parties.",
            "19.4. If any provision is determined to be invalid or unenforceable, the remaining provisions shall continue in effect to the extent permitted by law.",
            "19.5. Mandatory federal transportation laws and applicable uShip platform rules shall prevail over any conflicting contractual provision.",
        ],
    },
    {
        title: "20. Acknowledgment and Acceptance",
        lines: [
            "By signing below, both parties acknowledge that they have read, understood, and agreed to the terms of this Master Customer–Broker Agreement.",
        ],
    },
];

const USHIP_ONETIME_SECTIONS: CustomerAgreementSection[] = [
    {
        title: "Introduction",
        lines: [
            'This Customer–Broker Agreement ("Agreement") is entered into by and between Green Logistics LLC ("Broker") and the customer identified below ("Customer").',
            "Green Logistics LLC is a licensed property transportation broker operating under FMCSA Broker Authority MC #1237784.",
            "The Broker agrees to arrange transportation services through an authorized third-party motor carrier, subject to the following terms and conditions.",
        ],
    },
    {
        title: "3. Broker's Services",
        lines: [
            "3.1. Broker agrees to arrange transportation through a properly authorized motor carrier.",
            "3.2. Broker will coordinate the shipment, communicate relevant transportation information, and make reasonable efforts to monitor pickup and delivery progress.",
            "3.3. Broker will use reasonable care in selecting and arranging transportation through an appropriate motor carrier.",
            "3.4. Broker acts as a transportation broker and is not the motor carrier physically transporting the shipment.",
            "3.5. The actual motor carrier will be responsible for performing the transportation services under its applicable operating authority and transportation documents.",
        ],
    },
    {
        title: "4. Transportation Price and Payment",
        lines: [
            "Payment Schedule (choose one on the agreement form): (A) 50% / 50% — First Payment 50% due immediately after pickup and confirmation that the shipment has been loaded; Final Payment 50% due upon delivery and before unloading where legally permissible and agreed by the parties; or (B) Full payment after pickup — 100% of the agreed transportation charge due immediately after pickup and confirmation that the shipment has been loaded. The selected schedule on this form controls for this shipment.",
            "4.1. The Customer agrees to pay the full transportation amount according to the agreed schedule selected on this form.",
            "4.2. Payment must be made using the payment method confirmed by the parties.",
            "4.3. For direct-payment transactions, accepted methods may include Zelle, Venmo, Cash App, PayPal, bank transfer, or another mutually approved method.",
            "4.4. For uShip Payments transactions, all applicable uShip payment procedures must be followed. No payment code may be requested before delivery.",
            "4.5. Any payment processing surcharge must be disclosed and agreed upon in advance and must comply with applicable law and payment processor rules.",
            "4.6. The Customer's payment obligation is independent of a separate cargo damage or insurance claim, subject to applicable law and any mandatory payment rights.",
            "4.7. Any overdue balance may be subject to lawful collection procedures and reasonable collection costs where recoverable by law.",
        ],
    },
    {
        title: "5. Shipment Information and Customer Responsibilities",
        lines: [
            "5.1. Customer warrants that all shipment information provided to Broker is accurate and complete.",
            "5.2. Customer must disclose all relevant information, including dimensions, weight, commodity type, quantity, packaging, loading conditions, unloading conditions, and access restrictions.",
            "5.3. Customer must ensure that the shipment is properly prepared, packaged, and available at the agreed pickup location.",
            "5.4. Any material discrepancy between the original shipment description and the actual shipment may require a revised transportation rate, different equipment, additional services, or rescheduling.",
            "5.5. Any revised charges must be communicated to Customer and approved in writing before the additional service is performed, except where otherwise permitted by applicable law.",
        ],
    },
    {
        title: "6. Additional Services and Charges",
        lines: [
            "The following charges apply when the relevant service or circumstances are applicable and the charge has been disclosed and agreed upon:",
            "A. Truck Ordered but Not Used — A $200 charge may apply when a carrier has been dispatched and the shipment cannot be loaded due to Customer's cancellation, unavailability, inaccurate information, or failure to provide the shipment as agreed.",
            "B. Detention — The first two hours at pickup or delivery are free. Thereafter, detention is $50 per additional hour, subject to prior agreement and applicable carrier circumstances.",
            "C. Driver Assistance — Additional driver assistance, loading, unloading, or handling services may range from $150 to $500 depending on the requested work. The specific amount must be approved before the service is performed.",
            "D. Additional Equipment and Services — Any additional equipment, special handling, re-delivery, storage, or other accessorial service must be disclosed and approved in writing before the additional cost is incurred, except as permitted by applicable law.",
        ],
    },
    {
        title: "7. Pickup, Delivery, and Delays",
        lines: [
            "7.1. Pickup and delivery schedules are estimates unless a specific guaranteed appointment has been expressly confirmed in writing.",
            "7.2. Delays may occur due to weather, traffic, road restrictions, mechanical issues, accidents, government restrictions, carrier scheduling, or other circumstances beyond reasonable control.",
            "7.3. Broker will make reasonable efforts to notify Customer of material delays and provide available shipment updates.",
            "7.4. Broker is not responsible for indirect or consequential losses arising from transportation delays except to the extent liability is imposed by applicable law or expressly accepted in a separate written agreement.",
        ],
    },
    {
        title: "8. Cargo Insurance, Loss, and Damage",
        lines: [
            "8.1. Customer acknowledges that Broker arranges transportation through an independent motor carrier and does not itself provide motor carrier cargo insurance.",
            "8.2. The motor carrier's insurance coverage is governed by the actual policy, including applicable limits, exclusions, deductibles, and conditions.",
            "8.3. Any stated insurance limit is subject to policy verification and does not constitute a guarantee that every loss will be covered or paid.",
            "8.4. Customer should inspect the shipment at delivery and document visible damage, shortages, or other discrepancies on the delivery receipt or BOL.",
            "8.5. Customer must notify Broker promptly of any suspected cargo loss or damage.",
            "8.6. Formal claims must be submitted in writing to the responsible carrier in accordance with applicable law, the applicable bill of lading, and the carrier's lawful claim procedures.",
            "8.7. Broker will reasonably assist Customer with communication, documentation, and coordination of the claim with the responsible carrier or insurer.",
            "8.8. The carrier and/or its insurer will investigate the claim and determine coverage and payment in accordance with applicable law and the applicable insurance policy.",
            "8.9. Broker does not guarantee claim approval, reimbursement, or a particular settlement amount.",
            "8.10. Nothing in this Agreement waives or reduces any rights or remedies that cannot legally be waived.",
        ],
    },
    {
        title: "9. Cancellation and Rescheduling",
        lines: [
            "9.1. Customer must promptly notify Broker of any cancellation or requested scheduling change.",
            "9.2. If a carrier has been dispatched or has incurred reasonable transportation-related expenses due to Customer's cancellation or failure to provide the shipment as agreed, Customer may be responsible for applicable documented costs.",
            "9.3. Any cancellation of a shipment booked through uShip must also follow the applicable uShip cancellation process.",
        ],
    },
    {
        title: "10. Indemnification",
        lines: [
            "Each party shall be responsible for its own negligence, willful misconduct, violations of applicable law, and material breach of this Agreement.",
            "Customer shall be responsible for losses or additional costs resulting from inaccurate shipment information, undisclosed hazardous materials, improper packaging, or failure to meet agreed shipment requirements, to the extent legally attributable to Customer.",
            "Neither party shall be liable for indirect or consequential damages except where such liability cannot legally be excluded.",
        ],
    },
    {
        title: "11. Governing Law and Dispute Resolution",
        lines: [
            "This Agreement shall be governed by applicable federal transportation law and, where not preempted, the laws of the Commonwealth of Pennsylvania.",
            "Any dispute shall be brought before a court of competent jurisdiction in Pennsylvania, subject to applicable jurisdiction and venue requirements.",
            "The parties agree to make reasonable efforts to resolve disputes through direct written communication before commencing litigation.",
        ],
    },
    {
        title: "12. Electronic Signatures and Entire Agreement",
        lines: [
            "12.1. Electronic signatures and electronic records shall have the same legal effect as handwritten signatures where permitted by applicable law.",
            "12.2. This Agreement, together with the applicable written shipment confirmation and approved amendments, represents the agreement between the parties concerning this shipment.",
            "12.3. Any modification to the agreed transportation price, payment terms, shipment requirements, or additional services must be documented and accepted in writing by both parties.",
            "12.4. If any provision is found unenforceable, the remaining provisions shall remain effective to the extent permitted by law.",
            "12.5. This Agreement does not supersede mandatory uShip platform rules applicable to a shipment booked through uShip.",
        ],
    },
    {
        title: "13. Acknowledgment and Acceptance",
        lines: [
            "By signing below, Customer confirms that:",
            "The shipment information is accurate.",
            "The transportation price has been reviewed and accepted.",
            "The payment method and payment schedule have been confirmed.",
            "The applicable Terms & Conditions have been reviewed.",
            "Customer has authority to enter into this Agreement.",
        ],
    },
];

export function customerAgreementSections(
    type: CustomerAgreementType
): CustomerAgreementSection[] {
    return type === "LONG_TIME" ? LONG_TIME_SECTIONS : USHIP_ONETIME_SECTIONS;
}

/** Flat list of every operative line (for PDF bullets / tests). */
export function customerAgreementTerms(type: CustomerAgreementType): string[] {
    const out: string[] = [];
    for (const section of customerAgreementSections(type)) {
        for (const line of section.lines) {
            out.push(line);
        }
    }
    return out;
}

/**
 * Broker–Carrier Agreement Version 2.5.
 * Restores protections named from the original PDF that Version 2.4 shortened.
 * The seal procedure in Section 8 is the practical procedure requested for 2.5:
 * a broken Broker seal is secured and reported, and is not by itself an automatic total loss.
 * Carrier profile data is not stored in this text. Broker contact comes from BROKER_AGREEMENT_CONTACT.
 */
export type BrokerAgreementContact = {
    legalName: string;
    signerName: string;
    title: string;
    address: string;
    phone: string;
    email: string;
    mcNumber: string;
    usdotNumber: string;
};

export function buildBrokerCarrierAgreement(contact: BrokerAgreementContact): string {
    const broker = contact.legalName;
    return `${broker}
${contact.address}
Ph ${contact.phone}
MC # ${contact.mcNumber}  ·  USDOT # ${contact.usdotNumber}

BROKER – CARRIER AGREEMENT

This agreement is entered into between ${broker}, MC # ${contact.mcNumber}, USDOT # ${contact.usdotNumber}, and the Carrier identified in the Carrier Profile completed in Green OS (the “Carrier”).

1. Broker Status. Broker is a freight broker which arranges for third party motor carriers to provide cargo transportation for its customers, in accordance with its role as legally defined under 49 U.S.C. § 13102 Definitions (2), 49 C.F.R. § 371.2 and 49 U.S.C. § 14501(c)(1).

1.1 Carrier Status, Rights and Responsibility. Carrier will perform its Transportation Services for Broker and its Customers as an independent contractor and will not for any purpose be the agent of Broker or Broker’s Customers. Carrier has exclusive control and direction of the work Carrier performs pursuant to this Agreement. Carrier will not contract or take other action in Broker’s name without Broker’s prior written consent.

Carrier agrees to assume full responsibility for the payment of all local, state, federal and intra-provincial payroll taxes, and contributions or taxes for unemployment insurance, worker’s compensation insurance, pensions, and other social security or related protection with respect to the persons engaged by Carrier for Carrier’s performance of the transportation and related services, and Carrier shall indemnify, defend and hold Broker, and its Customer harmless there from. Carrier shall provide Broker, with Carrier’s Federal Tax ID number and a copy of Carrier’s IRS Form W-9 prior to commencing any transportation or related services for Broker, under this Agreement.

1.2. No Right to Lien or Delay Release of Cargo or Equipment. Carrier will not assert any lien or make any claim on any cargo or equipment, and no lien will attach against Broker, its Customers or any cargo or equipment, for failure of Broker, the Customer or any other third party to pay Carrier for charges due to Carrier.

1.3 Waiver of Rights. Carrier shall, notwithstanding any other terms of this agreement, expressly waive all rights and remedies under Title 49 U.S.C., Subtitle IV, Part B to the extent they conflict with this Agreement.

1.4 Sub-Contract Prohibition. Carrier expressly agrees that all freight tendered to it by Broker shall be transported on equipment operated only under the authority of Carrier, and that Carrier shall not in any manner sub-contract, broker, or in any other form arrange for the freight to be transported by a third party without the prior written consent of Broker. If Carrier breaches this provision, Broker shall have the right of paying the monies it owes Carrier directly to the delivering Carrier, in lieu of payment to Carrier. Upon Broker’s payment to delivering Carrier, Carrier shall not be released from any liability to Broker under this agreement. In addition to the indemnity obligation reflected in this agreement the Carrier will be liable for consequential damages for violation of this clause of the agreement.

1.5 Authorities and Licenses. Compliance with Laws. Carrier warrants that it will provide physical transportation of shipments as a fully qualified motor carrier that holds all required federal and state operating authorities. If Carrier’s safety rating changes at any time during this Contract’s term or if Carrier is sold, merges or dissolves or experiences a change in control of ownership, Carrier will notify Broker immediately (within 24 hours). Carrier will comply with applicable federal, state and/or local laws and regulations (including obtaining all permits and licenses), and any representations or contractual clauses required thereby will be incorporated herein by reference or by operation of law.

2. Booking Confirmation. Carrier shall transport shipments arranged by Broker pursuant to carrier load or Booking confirmation sheet(s) included herewith or subsequently incorporated by reference (See Schedule A annexed hereto).

2.1 CANCELLATION FEE. In the event that the Carrier cancels a scheduled shipment after confirmation, a cancellation fee of $50 shall apply. The cancellation fee shall be deducted from any amounts owed to the Carrier for services rendered, or the Carrier shall remit the cancellation fee to the Broker within five (5) business days of the cancellation.

3. Compensation. Broker shall pay Carrier for services rendered in an amount equal to the rates and accessorial charges agreed to on the Broker/Carrier Rate Confirmation Sheet or other signed writing. Carrier must submit proof of delivery with invoices to Broker as a precondition of payment for services hereunder. Unless a Payment Option elected in Green OS says otherwise, payment terms are thirty (30) days from receipt of the necessary supporting documentation. The Payment Option Carrier selects and stores in Green OS overrides this thirty (30) day period.

3.1 Payment of Invoices. Carrier agrees that Broker is the sole party responsible for payment of Carrier’s invoices and that, under no circumstance, will Carrier seek payment from other parties, to include the shipper or consignee. Payment is made only to the Carrier or, when a factoring option is in effect, to the factoring company named in the Carrier Profile after a valid Letter of Release is on file.

4. Insurance. Carrier shall provide any insurance required by a government body for the transportation described in load confirmations from Broker, and shall deliver certificates of insurance to Broker before Carrier begins transportation services under this Agreement. Every policy required here must be written by an insurer with an A.M. Best rating of “B+” VII or better that is authorized to do business where Carrier operates. Broker shall be named as Certificate Holder. Broker shall be given at least thirty (30) days’ prior written notice of cancellation, change, or non-renewal, subject to the insurer’s ability to give that notice and to applicable law.

Carrier’s insurance shall be primary and non-contributory. It shall respond and pay covered losses before any other insurance available to Broker, its affiliates, or its customers. To the extent the insurer can grant it and the law allows it, Carrier, its insurer, and any person claiming by, through, or under Carrier waive subrogation and claims against Broker, Broker’s affiliates, and Broker’s customers for a loss that is insured, or required to be insured, under this Agreement.

Carrier shall at all times have and maintain:

(i) Motor Truck Cargo insurance covering the full value of the cargo, with a limit of not less than US$100,000 per shipment. The deductible shall not exceed US$10,000 per shipment. The same limits and the same deductible apply while the cargo is in storage.

(ii) Commercial Automobile Liability insurance with a combined single limit of not less than US$1,000,000 per occurrence and with no aggregate limit.

(iii) Commercial General Liability insurance of not less than US$1,000,000 per occurrence.

(iv) Workers’ Compensation insurance as required by applicable law, and Employer’s Liability insurance of not less than US$500,000. When transportation is performed entirely within Canada, Carrier shall also meet the applicable provincial Workers’ Compensation Board requirements and provide proof when Broker asks.

(v) When hazardous materials are transported, the limits required by 49 C.F.R. §§ 387.7 and 387.9, an MCS-90 endorsement, and Broadened Pollution Liability coverage.

No required policy shall exclude or limit coverage for unattended equipment or cargo, unscheduled equipment, unscheduled drivers, fraud or infidelity, a tarp warranty, wetness or dampness, a geographic restriction, an unattached trailer, a designated premises or project, or a radius restriction, except where the law itself requires that limitation.

5. Carrier Moving Perishables. When a shipment requires temperature control, Carrier shall inspect and maintain the refrigeration or heating unit and shall keep enough fuel in that unit for the entire movement. Carrier shall inspect each such unit at least once each month, keep a written inspection record, retain that record for at least one (1) year, and give the record to Broker and to Carrier’s cargo insurer when either of them asks. Carrier is liable for loss caused by insufficient fuel. Carrier shall give its cargo insurer the records that relate to a loss. For perishable goods, cargo liability includes Destination Market Value, meaning the market value of the goods at destination at the time delivery was due, when that amount is greater than replacement cost or the commercial invoice. A Shipper may file a claim directly with Carrier. Carrier shall process cargo claims under 49 C.F.R. §§ 370.1 through 370.11 where those rules apply. That filing path does not limit Broker’s rights under this Agreement.

6. Shipping Document Execution. Carrier is to be named on the bill of lading as the “carrier of record.”

6.1 BILL OF LADING. The Bill of Lading (BOL) shall include, at a minimum, the shipper’s and consignee’s names and addresses, a description of the vehicles or cargo being transported, the origin and destination of the shipment, and any other information required by law or requested by Broker. Carrier shall give Broker the BOL when the vehicle or cargo is picked up at the place of origin. Carrier shall give Broker the BOL and the other shipping documents after the transportation is finished. When Broker asks, Carrier shall also give copies of those documents to Broker’s customers.

7. INDEMNIFICATION. BROKER, ITS AFFILIATES, AND ITS CUSTOMERS ARE INTENDED THIRD-PARTY BENEFICIARIES OF THIS SECTION. “LOSSES” MEANS PERSONAL INJURY AND BODILY INJURY, PROPERTY DAMAGE, THEFT OF PROPERTY, PENALTIES, CLAIMS, LAWSUITS, DEMANDS, REASONABLE ATTORNEYS’ AND PARALEGALS’ FEES, COSTS OF DEFENSE, INVESTIGATION, AND SETTLEMENT, ENVIRONMENTAL CLEANUP AND REMEDIATION COSTS, AND THE COST OF ENFORCING THIS INDEMNITY. CARRIER WILL INDEMNIFY, DEFEND, AND HOLD HARMLESS BROKER, ITS AFFILIATES, AND ITS CUSTOMERS FROM LOSSES ARISING OUT OF CARRIER’S TRANSPORTATION SERVICES, THE USE OR MAINTENANCE OF CARRIER’S EQUIPMENT, THE LOADING, UNLOADING, HANDLING, POSSESSION, OR CUSTODY OF CARGO, AND ANY BREACH OF THIS AGREEMENT BY CARRIER OR CARRIER’S REPRESENTATIVES. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THIS DUTY APPLIES EVEN WHEN THE LOSS IS ALLEGED TO HAVE BEEN CAUSED IN PART BY THE NEGLIGENCE OR WILLFUL MISCONDUCT OF AN INDEMNIFIED PERSON.

8. Carrier’s Cargo Liability. Carrier assumes liability for the greater of replacement cost, the Shipper’s or Consignor’s commercial invoice, or market value, for loss, damage, or destruction of goods or property tendered to Carrier by Broker, for the entire course of carriage. Where Section 5 sets a Destination Market Value, that amount is included in this comparison.

Carrier shall inspect the cargo when Carrier receives it. If the cargo is already damaged or is not fit to transport, Carrier shall tell Broker immediately. If the cargo was received intact and is later delivered damaged, short, or lost, Carrier is presumed responsible unless Carrier proves that it is not responsible by clear and convincing evidence.

If a Broker seal is broken, missing, compromised, or not applied as Broker instructed, Carrier shall stop and secure the shipment, tell Broker immediately, and wait for Broker’s written instructions before moving the freight again, except for emergency action the law requires. Carrier shall record the seal condition with photographs and the shipping records. This procedure preserves the claims and liability rights in this Agreement. A Broker seal problem is not, by itself, an automatic total loss of the shipment.

Broker may recover the customer’s actual documented loss from amounts otherwise owed to Carrier, subject to applicable law and a valid claim. If a claim is not resolved within ninety (90) days after Carrier has received the claim and the supporting documents, Broker may hold back that documented actual loss, subject to applicable law. Carrier shall notify Broker immediately of any accident, shortage, loss, or damage. When Broker reasonably requires it, Carrier shall return damaged cargo to the origin or to another place Broker names, at Carrier’s expense. Carrier shall pay a claim within thirty (30) days after receiving the claim and the supporting documents, subject to applicable liability and claim procedures, including 49 C.F.R. Part 370 where that part applies to notice and salvage.

8.1 Salvage Claims. To the extent the law allows, Carrier waives any right to salvage or resell damaged customer goods on its own. Carrier shall not sell those goods, and shall not place them in a salvage market, an employee store, or any other secondary outlet, without Broker’s prior written consent. Broker may require Carrier to return the goods or to dispose of them, and Carrier shall pay that cost. If the customer receives a documented actual salvage value for returned goods, Carrier shall be credited with that amount.

9. Governing Law. Consent to Jurisdiction and Integration. This Contract will be construed, to the extent not preempted by applicable federal law, under the laws of the State of California. Where a jury waiver is enforceable, Broker and Carrier waive trial by jury. The exclusive jurisdiction for a dispute between Broker and Carrier is the federal or state courts sitting in California. Each party waives any objection to that venue, including any defense that the forum is an inconvenient forum. A third-party claim that Carrier must indemnify may be heard in the court where that third-party claim is filed. This Agreement, together with each Load Confirmation issued under it and the Payment Option stored in Green OS, is the entire agreement of the parties on this subject. It may be amended only by a writing signed by both parties.

9.1 Safety Rating. Carrier shall endeavor to maintain a satisfactory U.S. DOT Safety Rating but under no circumstances is Carrier allowed to provide services if their safety rating falls to “unsatisfactory.”

10. Confidentiality Obligations. During this Contract’s term and for twelve (12) months after it ends, Carrier shall protect Broker’s confidential information, shall not use it to Broker’s competitive detriment, and shall not use it for any purpose outside this Agreement. Carrier shall limit access to representatives who need the information to perform this Agreement and who are required to protect it. Confidential information includes customer information, rates and pricing, origins and destinations, commodity types, shipment information, traffic volumes, personnel, computer systems, business practices, and the provisions of this Contract. Before Carrier discloses confidential information because a government authority or a court requires it, Carrier shall notify Broker when the law allows that notice.

10.1 Non-Solicitation of Customers. During this Contract’s term and for nine (9) months after it ends, Carrier and Carrier’s representatives shall not, directly or indirectly, solicit or provide transportation service to a customer who became known to Carrier through Broker’s engagement or the transportation relationship, without Broker’s prior written consent. That relationship exists when (i) the customer became known because of Broker, (ii) Carrier learned the lanes, routes, or commodities through Broker, or (iii) the first shipment for that customer was tendered by Broker. This section does not reach a customer with no such connection to Broker. If Carrier breaks this section, Carrier shall pay Broker a commission equal to ten percent (10%) of the transportation charges for each such shipment, up to a maximum of US$200 for one shipment.

11. Savings Clause. If any provision is held invalid, the remainder remains in force.

12. Term. This Agreement shall be for the period of one (1) year and shall be automatically renewed unless cancelled. Either party may terminate upon fifteen (15) days written notice. By signatory hereto, CARRIER represents that it has the authority and ability to enter into legally binding contracts and agrees to be bound by the terms and conditions of this Agreement effective immediately.

IN WITNESS WHEREOF:

(BROKER) – ${broker}
Authorized Signature: electronic signature applied by Green OS for ${contact.signerName}, ${contact.title}
Printed Name – ${contact.signerName} / Title – ${contact.title}
Company Address: ${contact.address}
Phone – ${contact.phone}
E-Mail ${contact.email}

(CARRIER) – legal name, signature, printed name, title, address, phone, and email are taken from the Carrier Profile and the electronic signature in Green OS. They are not pre-filled with another carrier’s information.

PAYMENT OPTIONS (the option stored in Green OS overrides the 30-day period in Section 3):
• Standard Payment: payment within 20–25 days from receipt of the invoice and all required documents.
• Quick Pay (3%): payment within 3–5 business days. A fee of 3% is deducted from the invoiced amount. ACH direct deposit to the Carrier.
• Quick Pay (5%): payment within 24 hours. A fee of 5% is deducted from the invoiced amount.
• Factoring company: payment is made only to the factoring company named in the Carrier Profile, and only after Broker has that company’s information and a valid Letter of Release (LOR). Quick Pay is not processed to a factoring company until the LOR is on file.

${broker} — Broker-Carrier Agreement Version 2.5
`;
}

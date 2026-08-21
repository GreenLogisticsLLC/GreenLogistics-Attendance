# PHASE 2A — Green Logistics Document AI / Validation Specification

**STATUS:** SPECIFICATION COMPLETE — awaiting explicit approval  
**SCOPE:** Design only. No OCR implementation, no migrations, no production deploy.  
**Commit:** NONE  
**Deployment:** NONE  

---

## 0. Executive summary

Phase 2A defines how GreenOS Document AI will classify, extract, match, and validate carrier/load documents using Green Logistics **reference templates** as Level A/B semantic guides — not pixel-perfect layout matchers.

Authoritative business minima (insurance, certificate holder, POD receiver signature, MC/DOT exact match) come from the **Broker–Carrier Agreement** and load docs — **not** from an LLM.

---

## 1. Document Type Registry

Canonical GreenOS type codes (align with existing `CARRIER_DOC_TYPES` / `LoadDocument.docType`; additions noted):

| Spec type | GreenOS code | Storage | Notes |
|-----------|--------------|---------|-------|
| Carrier Profile | `CARRIER_PROFILE` | CarrierDocument | **NEW** — not in current constants |
| Broker–Carrier Agreement | `BROKER_CARRIER_AGREEMENT` | CarrierDocument | Exists |
| W-9 | `W9` | CarrierDocument | Exists |
| Insurance / COI / EOI | `COI` (primary) / `INSURANCE` (alias) | CarrierDocument | Prefer single validation family `INSURANCE_FAMILY` |
| MC Authority | `MC_AUTHORITY` | CarrierDocument | Exists |
| NOA | `NOA` | CarrierDocument | Exists |
| Rate Confirmation | `RATE_CONFIRMATION` | LoadDocument (+ optional CarrierDocument for packet) | Exists |
| BOL | `BOL` | LoadDocument | Exists |
| POD | `POD` | LoadDocument | Exists on LoadDocument; **no official GL POD template uploaded** |

### Per-type registry (summary)

#### A. `CARRIER_PROFILE`
- **Description:** Green Logistics one-page (or short) carrier intake profile.
- **Identifying characteristics:** Title “Carrier Profile”; fields Carrier Name, Address, City/State/Zip, Dispatch Contact, Phone/Fax, Dispatch E-mail, FED ID #, MC#, DOT#, Equipment and Quantity.
- **Required fields:** legalName, address, city, state, zip, dispatchContact, phone, dispatchEmail, mcNumber, dotNumber.
- **Optional:** fax, fedId (agreement requires W-9 separately), equipment, equipmentQty.
- **Conditional / not on reference:** HAZMAT, HAZMAT expiration, satellite tracking, provider — **not present on analyzed reference; do not require until template updated**.
- **Signatures:** none required on profile itself.
- **Dates:** none required.
- **GreenOS match:** legalName (normalized), mcNumber (exact digits), dotNumber (exact digits), address/phone/email (soft match → REVIEW if conflict).
- **Business rules:** MC/DOT must be present and match Carrier when linked.
- **Confidence threshold:** fields ≥ 0.85 for auto VALID; else REVIEW.
- **Review:** name/MC/DOT uncertain or soft address conflict.
- **Reject:** missing MC or DOT; critical MC/DOT mismatch.

#### B. `BROKER_CARRIER_AGREEMENT`
- **Description:** Green Logistics Broker–Carrier Agreement (multi-page contract + payment options + signature block).
- **Identifying:** “BROKER - CARRIER AGREEMENT”, broker MC #1237784, insurance clause with B+ / limits, signature pages.
- **Required:** agreementDate; brokerLegalName; brokerMc; carrierLegalName; carrierMc; brokerAuthorizedSignature; carrierAuthorizedSignature; brokerPrintedName; carrierPrintedName; paymentOption (one selected).
- **Optional:** titles, phones, emails, addresses (validate when present).
- **Signatures:** Broker + Carrier **required** (handwritten/e-sign appearance).
- **Dates:** agreement effective date required.
- **GreenOS match:** carrier name + MC vs Carrier; broker MC must be `1237784`.
- **Business rules:** establishes packet requirements (W-9, authority, insurance minima) — enforced on **packet validation**, not by inventing agreement text via LLM.
- **Reject:** missing either party signature; carrier MC mismatch; unsigned payment selection when required by ops policy.

#### C. `W9`
- **Description:** Official IRS Form W-9 (any revision year; reference is Rev. March 2024).
- **Identifying:** “Form W-9”, “Request for Taxpayer Identification Number”, Part I TIN, Part II Certification.
- **Do not** require Green Logistics visual layout.
- **Required:** name (Line 1) and/or business name (Line 2); federal tax classification; address + city/state/ZIP; TIN present (SSN **or** EIN) **or** explicit awaiting-issuance; certification signature; signature date.
- **Optional:** requester name/address; disregarded entity nuances.
- **Signatures:** certification signature **required**.
- **PII:** full SSN/EIN never in ai_runs previews, logs, or unauthorized AI replies; UI redaction `******4853`.
- **Review:** TIN uncertain/obscured; classification vs entity type conflict; name vs Carrier legalName soft mismatch.
- **Reject:** no TIN and not awaiting issuance; no signature; typed-only name in signature box with no signature mark (per signature rules).

#### D. `COI` / `INSURANCE` (family)
- **Description:** ACORD Certificate of Liability Insurance and/or Evidence of Insurance.
- **Identifying:** “CERTIFICATE OF LIABILITY INSURANCE”, ACORD 25, Insured, Certificate Holder, policy eff/exp, Auto / Cargo / GL / WC.
- **Required (GL):** insuredName; certificateDate (when present); autoLiabilityLimit; motorTruckCargoLimit; policyEff; policyExp; certificateHolder (= GREEN LOGISTICS LLC for COI used for GL onboarding); MC and/or DOT when printed.
- **Optional:** producer, NAIC, VIN, vehicle, GL limits, EL limits, WC, revision/cert numbers.
- **Signatures:** authorized representative optional for status; absence alone ≠ INVALID if coverages clear.
- **Business rules:** see §6 Business Rules Matrix.
- **Reject / RED:** expired; cargo &lt; $100k; auto &lt; $1M; wrong/missing certificate holder (when COI is for GL); critical MC/DOT mismatch.

#### E. `MC_AUTHORITY`
- **Description:** FMCSA operating authority certificate (MC-*-C common carrier property).
- **Identifying:** FMCSA header, “CERTIFICATE”, “MC-######-C”, “U.S. DOT No.”, legal carrier name, service date.
- **Required:** legalName; mcNumber; authorityCertificateId (e.g. MC-1820780-C); serviceDate; authorityType (common carrier property except HHG when stated).
- **Optional:** city/state; explicit status (usually implied by certificate existence).
- **Signatures:** FMCSA official block — not carrier signature.
- **Match:** MC/DOT **exact normalized digits**; legal name normalized compare.
- **CRITICAL_MISMATCH** if MC/DOT digits differ from Carrier — never auto-fix GreenOS.
- **Do not** classify broker BMC-84 / surety bond pages as carrier MC authority (see package boundary note).

#### F. `NOA`
- **Description:** Notice of Assignment of accounts receivable to a factor.
- **Identifying:** explicit assignment of invoices/payments language; factoring company as assignee; carrier as assignor; often DocuSign/envelope metadata.
- **Not sufficient:** mere presence of word “factoring” (e.g. Rate Con payment option).
- **Required:** carrierLegalName; factoringCompanyName; assignment statement; signature (carrier and/or factor per form); signature date when form requires.
- **Optional:** tax ID, addresses, acknowledgment blocks.
- **Reject:** missing assignment statement; missing required signature; wrong carrier identity vs GreenOS.

#### G. `RATE_CONFIRMATION`
- **Description:** Green Logistics Load Confirmation / Rate Confirmation.
- **Identifying:** “LOAD CONFIRMATION”, load number, flat rate, **explicit disclaimer: “This is a rate confirmation not a BOL.”**
- **Must NOT** classify as BOL.
- **Required:** loadNumber; broker; brokerMc; carrier; carrierMc; origin; destination; pickupDate; deliveryDate; commodity; weight; equipment; flatRate/totalRate; carrier signature when returned signed; broker signature when present on form.
- **Optional:** times, driver, phones, detention/layover/TONU/late/Macropoint notes, payment option.
- **Match:** loadNumber → ShipmentLead.loadNumber; carrier MC/name → Carrier / shipment carrier fields.

#### H. `BOL`
- **Description:** Bill of Lading (shipper/consignee/carrier commodity document).
- **Identifying:** “Bill of Lading”, SHIPS FROM / SHIPS TO, BOL number, pickup date; **must not** be Rate Confirmation.
- **Required:** bolNumber; pickupDate; shipper + address; consignee + address; carrier; commodity; weight; origin/destination (or derived from ship/consign); shipper signature/date; carrier signature/pickup date.
- **Receiver signature:** required for **delivery/POD use** of BOL as delivery proof; at pickup-only stage may be REVIEW if empty.
- **Separate signature objects** for shipper, carrier, receiver.

#### I. `POD`
- **Description:** Proof of Delivery — any industry form proving delivery + **final receiver signature**.
- **No official Green Logistics POD visual template uploaded** — validate on **business requirements**, not layout clone.
- **Required:** document type POD (or BOL used as POD with delivery section); shipment/load identity; carrier identity; delivery date; **final receiver signature PRESENT** (handwritten/valid e-sign); signature date when required by form.
- **Never VALID** if final receiver signature missing/typed-only/printed-only/empty box/uncertain below threshold.

---

## 2. Reference documents analyzed

| File | Pages | Boundary / types found |
|------|-------|------------------------|
| `GREEN LOGISTICS LLC package (2) (2) (1).pdf` | 16 | **p1–2** Carrier Profile; **p2–11** Broker–Carrier Agreement + payment options + signatures; **p11** near-blank; **p12–16** Broker **BMC-84 / Gray Insurance surety** for GREEN LOGISTICS LLC (**not** carrier MC Authority) |
| `1779981361063-…jpg` / W-9 screenshot | 1 of 6 shown | IRS **W-9** Rev. March 2024 (carrier packet companion; multi-page file in editor) |
| `EOI - GREEN LOGISTICS  08132026.pdf` | 1 | ACORD COI / EOI; holder **GREEN LOGISTICS LLC**; Auto $1M; Cargo $100k; MC/DOT/VIN |
| `EvidenceofInsurance23121929 (1) (1).pdf` | 1 | Same insurer/policy family; titled Evidence of Insurance; **certificate holder block weaker/absent in extract** vs EOI file |
| `GRANTED MC LETTER 1820780 (1).pdf` | 1 | FMCSA MC Authority |
| `GRANTED MC LETTER 1820780 (1) (1).pdf` | 1 | **Duplicate** of above (same size) |
| `Notice_of_Assignment (2) (1).pdf` | 1 | DocuSign envelope only in text layer — **image/vision required** for NOA body |
| `75246 (1) (1).pdf` | 1 | **Rate Confirmation** Load 75246 (explicitly not a BOL) |
| `BOL 75246 (1).pdf` | 1 | **BOL** 75246 |

**Package rule:** Do not treat each of 16 pages as a separate upload type. Split into logical documents: Profile | Agreement | (ignore/flag broker bond pages as `UNSUPPORTED` / `OTHER` for carrier onboarding).

---

## 3. Field Extraction Matrix

Legend: **R** required · **O** optional · **C** conditional · **PII** sensitive

### Carrier Profile
| Field | Req | Notes from reference |
|-------|-----|----------------------|
| legalName | R | I GET AROUND TRANSPORTATION LLC |
| address | R | 2513 DON PEDRO RD SPC 22 |
| city/state/zip | R | CERES, CA 95307 |
| dispatchContact | R | Jack William |
| phone | R | 512-270-0406 |
| fax | O | blank |
| dispatchEmail | R | jackdispatch28@gmail.com |
| fedId | O* | blank on profile (*required via W-9 packet) |
| mcNumber | R | 1820780 |
| dotNumber | R | 4575864 |
| equipment / qty | O | 40ft |
| hazmat / satellite | — | **Not on reference template** |

### Agreement
| Field | Req |
|-------|-----|
| agreementDate | R |
| brokerLegalName / brokerMc | R / R (1237784) |
| carrierLegalName / carrierMc | R / R |
| broker + carrier signatures, printed names, titles | R / R / O |
| phones, emails, addresses | O (validate if present) |
| paymentOption | R (one of Standard / QP 3% / QP 5% / Factoring) |

### W-9
| Field | Req | PII |
|-------|-----|-----|
| name / businessName | R (at least one) | |
| taxClassification | R | |
| address / city / state / zip | R | |
| tinType (SSN\|EIN) + tinValue | R | **PII** |
| signature + signatureDate | R | |

### Insurance / COI
| Field | Req |
|-------|-----|
| insuredName, producer | R / O |
| certificateDate, policyEff, policyExp | R where printed |
| autoLiabilityCsl, cargoLimit, glLimit, elLimit | R / R / O / C |
| certificateHolder | R for GL onboarding COI |
| mcNumber, dotNumber, vin, vehicle | O but match if present |
| insurer, naic, policyNumber | O |

### MC Authority
| Field | Req |
|-------|-----|
| legalName, mcNumber, dotNumber | R |
| certificateNumber (MC-*-C), serviceDate, authorityType | R |

### NOA
| Field | Req |
|-------|-----|
| carrierLegalName, factoringCompany | R |
| assignmentStatement | R |
| signature(s), signatureDate | R / C |
| taxId, addresses | O / PII |

### Rate Confirmation
| Field | Req |
|-------|-----|
| loadNumber, broker, brokerMc, carrier, carrierMc, carrierDot | R |
| origin, destination, pickupDate, deliveryDate | R |
| commodity, weight, equipment, flatRate | R |
| paymentOption, driver, phones, accessorial notes | O |
| brokerSignature, carrierSignature | R when “signed & return” workflow complete |

### BOL
| Field | Req |
|-------|-----|
| bolNumber, pickupDate | R |
| shipper(+addr), consignee(+addr), carrier(+mc) | R |
| commodity, weight, truck/trailer | R / R / O |
| shipperSignature, carrierSignature | R |
| receiverSignature + date | R for POD-grade; else REVIEW |

### POD
| Field | Req |
|-------|-----|
| loadOrBolId, carrier, deliveryDate | R |
| deliveryLocation, receiverName | O / O |
| **finalReceiverSignature** | **R** |
| signatureDate, exceptions/damage | C / O |

---

## 4. Signature Requirements Matrix

| Document | Who | Required? | Accept | Reject / Review |
|----------|-----|-----------|--------|-----------------|
| CARRIER_PROFILE | — | No | — | — |
| BROKER_CARRIER_AGREEMENT | Broker + Carrier | Yes | HANDWRITTEN / valid E_SIGN | MISSING, TYPED_ONLY, PRINTED_ONLY, UNCERTAIN |
| W9 | Taxpayer certification | Yes | HANDWRITTEN / valid E_SIGN | same |
| COI | Authorized rep | Optional | if present, record | absence alone ≠ fail |
| MC_AUTHORITY | FMCSA official | N/A (agency) | — | — |
| NOA | Assignor / factor per form | Yes | HANDWRITTEN / DocuSign appearance with visible mark | empty / typed-only |
| RATE_CONFIRMATION | Carrier (return); Broker | Yes when executed | HANDWRITTEN / E_SIGN | unsigned return = REVIEW/UNSIGNED |
| BOL | Shipper, Carrier; Receiver | Shipper+Carrier R; Receiver for delivery proof | multimodal | empty receiver → UNSIGNED/REVIEW |
| POD | **Final receiver** | **Critical Yes** | HANDWRITTEN / valid E_SIGN only | typed/printed/empty/uncertain → **never VALID** |

### Signature object schema (future)
```json
{
  "role": "RECEIVER",
  "signaturePresent": true,
  "signatureType": "HANDWRITTEN",
  "signatureName": null,
  "signatureDate": "2026-08-20",
  "confidence": 0.96,
  "page": 2,
  "region": { "x": 0, "y": 0, "w": 0, "h": 0 },
  "status": "PRESENT"
}
```
Statuses: `PRESENT` | `MISSING` | `UNCERTAIN` | `TYPED_ONLY` | `PRINTED_ONLY`

---

## 5. GreenOS Matching Matrix

| Field | Entity | Compare | Auto-approve? |
|-------|--------|---------|---------------|
| mcNumber | Carrier / ShipmentLead.carrierMc | digits-only exact | Yes if equal |
| dotNumber | Carrier / ShipmentLead.carrierDot | digits-only exact | Yes if equal |
| loadNumber | ShipmentLead.loadNumber | exact normalized | Yes if equal |
| bolNumber | contentJson / docs | exact | Yes if equal |
| legalName | Carrier.legalName | case/punct/whitespace normalize | Soft: MATCH / REVIEW / MISMATCH |
| phone / email | Carrier | digits / lowercase | Soft |
| address | Carrier | cautious normalize | Soft → REVIEW on conflict |
| taxId | Carrier.federalTaxId | exact after mask | Authorized roles only; never fuzzy approve |
| rates / weights | ShipmentLead | numeric normalize | Soft / REVIEW |

**CRITICAL_MISMATCH:** MC or DOT digits differ → RED / MISMATCH; **never** write Carrier/ShipmentLead.

---

## 6. Business Rules Matrix (deterministic — code, not LLM)

Source: Broker–Carrier Agreement §4 / §1.1 / §3 / §6 + Rate Con notes.

| ID | Rule | Threshold / value | Fail status |
|----|------|-------------------|-------------|
| BR-INS-CARGO | Motor Truck Cargo minimum | ≥ $100,000 | BELOW_REQUIREMENT / INVALID |
| BR-INS-AUTO | Commercial Auto Liability CSL | ≥ $1,000,000 | BELOW_REQUIREMENT / INVALID |
| BR-INS-GL | Commercial General Liability | ≥ $1,000,000 | BELOW_REQUIREMENT / REVIEW or INVALID (configurable; default INVALID when limit readable) |
| BR-INS-EL | Employer’s Liability | ≥ $500,000 where WC/EL present | BELOW_REQUIREMENT / REVIEW |
| BR-INS-AMBEST | Insurer Best’s rating | B+ VII or better | REVIEW if unknown; INVALID if known below |
| BR-INS-HOLDER | Certificate holder | GREEN LOGISTICS LLC | MISMATCH / INVALID |
| BR-INS-PRIMARY | Carrier insurance primary | stated when detectable | REVIEW if absent |
| BR-DOC-W9 | W-9 required before haul | packet completeness | MISSING_REQUIRED_FIELD |
| BR-DOC-AUTH | Operating authority required | MC_AUTHORITY present + match | MISSING / MISMATCH |
| BR-PAY-POD | POD required for payment | agreement §3 | UNSIGNED blocks pay readiness |
| BR-RC-NOT-BOL | Rate Con ≠ BOL | disclaimer / type | wrong type if confused |
| BR-POD-SIG | Final receiver signature | multimodal PRESENT | UNSIGNED / REVIEW_REQUIRED |
| BR-MC-EXACT | MC identity | exact digits | CRITICAL_MISMATCH |
| BR-DOT-EXACT | DOT identity | exact digits | CRITICAL_MISMATCH |

---

## 7. Expiration Rules

| Document | Expiration source | Behavior |
|----------|-------------------|----------|
| COI / Insurance | policyExp (and certificate date for freshness) | `EXPIRED` if now &gt; policyExp; REVIEW if date UNCERTAIN |
| MC Authority | generally ongoing while compliant; serviceDate is grant date | Do not auto-expire solely on serviceDate; REVIEW if revoked language present |
| W-9 | no fixed expiry | Re-request on entity/TIN change (ops policy) |
| Agreement | 1-year auto-renew language | Track agreementDate; REVIEW if &gt; policy window without re-sign (ops configurable) |
| NOA | until revoked / superseded | REVIEW if superseded NOA exists |
| Rate Con / BOL / POD | load-scoped | No calendar expiry; validity = load identity + signatures |

---

## 8. Confidence Rules

Per-field object:
```json
{
  "field": "mcNumber",
  "value": "1820780",
  "confidence": 0.99,
  "source": "page_1",
  "status": "MATCH"
}
```

Field statuses: `FIELD_FOUND` | `FIELD_MISSING` | `FIELD_UNCERTAIN` | `FIELD_MATCH` | `FIELD_MISMATCH` | `BELOW_REQUIREMENT` | `EXPIRED`

Defaults (Phase 2B configurable):
- Auto VALID path: all critical fields confidence ≥ **0.90** (MC/DOT ≥ **0.95**).
- Any critical field &lt; threshold → **REVIEW_REQUIRED** (never guess).
- Signature UNCERTAIN → **REVIEW_REQUIRED**.
- Never silently approve incomplete/uncertain docs.

---

## 9. POD Signature Rules (critical)

1. Confirm type POD (or BOL delivery section used as POD).  
2. Inspect **final signature section / last page** with vision, not OCR-only.  
3. Accept only: HANDWRITTEN mark or valid electronic signature appearance.  
4. Reject as sufficient alone: typed name, printed name, empty box, label “Signature”, metadata “signed”, OCR “John Smith”.  
5. Empty signature + name + date present → **UNSIGNED** (or REVIEW_REQUIRED if ops chooses softer label — **default UNSIGNED**, never VALID).  
6. Visible handwritten signature with adequate confidence → signature validation **PASS**.  
7. Overall document VALID only if Levels 1–7 pass including signature.

**Mandatory test:** Name=John Smith, Date=08/20/2026, Signature=EMPTY → not VALID.

---

## 10. Human Review Rules

Trigger REVIEW_REQUIRED when any of:
- OCR/vision confidence below threshold  
- Signature UNCERTAIN / TYPED_ONLY  
- Soft name/address mismatch  
- AM Best unknown  
- GL/EL limits missing but form type implies them  
- Multi-document package boundary uncertain  
- TIN obscured  
- Certificate holder fuzzy match only  

Human UI (future): left original · right structured fields · per-field Document vs GreenOS vs Confidence vs Status vs Reason.  
Human may Accept / Reject / Request changes — **no auto master-data write**.

---

## 11. Final Status Model

Do **not** use a single boolean.

**Traffic light:** `GREEN` | `YELLOW` | `RED`

**Machine statuses (orthogonal detail):**  
`VALID` | `REVIEW_REQUIRED` | `INVALID` | `MISMATCH` | `EXPIRED` | `MISSING_REQUIRED_FIELD` | `UNSIGNED` | `UNSUPPORTED` | `NOT_ENOUGH_INFORMATION`

Validation levels (independently stored/visible):
1. Document type  
2. Structure  
3. Field completeness  
4. Signature  
5. GreenOS match  
6. Business rules  
7. Expiration  

---

## 12. Security / PII handling

- SSN/EIN: encrypt/protect per existing storage policy; redact UI/logs/ai_runs (`requestPreview` never contains full TIN).  
- Factoring bank details: same class as PII.  
- Signatures: store references/regions; don’t dump raw biometric images into LLM prompts unnecessarily.  
- Prefer text extraction; vision crops only needed regions.  
- ACL: same JWT user; `assertCarrierAccess` / `assertShipmentAccessOrThrow`; no AI service account.  
- Preserve original bytes + checksum; never overwrite CURRENT without versioning (existing CarrierDocument/LoadDocument versioning).

---

## 13. Recommended database model (future — do not create now)

Reuse: `CarrierDocument`, `LoadDocument`, storage services, `ai_runs`.

Add (minimum):

| Table | Purpose |
|-------|---------|
| `ai_document_jobs` | jobId, documentId, docSource (carrier\|load), status, checksum, model routing, actorUserId, created/completed, error |
| `ai_document_extractions` | jobId, documentType, pagesJson, rawTextRef, overallConfidence |
| `document_extraction_fields` | extractionId, fieldKey, valueRedacted, valueEncrypted, confidence, page, source, fieldStatus |
| `document_validation_results` | jobId, level1–7 JSON, trafficLight, finalStatus, reasonsJson, reviewerUserId, reviewedAt |

Do **not** create parallel document entities or public storage.

---

## 14. Recommended APIs (future — do not implement now)

All behind `authMiddleware` + role + carrier/shipment ACL:

- `POST /api/ai/documents/process` — `{ carrierDocumentId | loadDocumentId }` → `{ jobId }`  
- `GET /api/ai/documents/jobs/:jobId`  
- `GET /api/ai/documents/:documentId/validation`  
- Optional: `POST /api/ai/documents/jobs/:jobId/review` — human decision only  

---

## 15. Recommended UI

- Carrier / Load document row: traffic light + finalStatus.  
- Review screen: split pane; field table; signature panel with reason (PASS/FAIL).  
- Never show full TIN to unauthorized roles.  
- Clear labels: GROUNDED extraction vs human override.

---

## 16. Test cases (Phase 2B)

### CARRIER_PROFILE
valid · missing MC · MC mismatch · missing required field  

### W9
valid · missing TIN · uncertain TIN · missing signature · typed name only · missing date · carrier name mismatch · classification vs LLC conflict (REVIEW)  

### COI
valid · expired · cargo &lt; $100k · auto &lt; $1M · wrong holder · MC mismatch · DOT mismatch · uncertain expiration · EOI without holder  

### MC_AUTHORITY
valid · MC mismatch · DOT mismatch · wrong carrier · missing authority info · **broker BMC-84 must not classify as carrier MC_AUTHORITY**  

### NOA
valid · missing signature · wrong factor · wrong carrier · “factoring” on Rate Con alone ≠ NOA  

### RATE_CONFIRMATION
valid · carrier mismatch · MC mismatch · missing carrier signature · wrong load number · must not classify as BOL  

### BOL
valid · missing receiver signature · missing carrier signature · wrong carrier/MC · wrong BOL/load · missing delivery info  

### POD
valid signed · unsigned · typed-only · printed-only · empty box · uncertain · signature on final page · missing on final page · wrong carrier/load/date  

**POD golden negative:** receiver name + date, empty signature → UNSIGNED/REVIEW_REQUIRED, **never VALID**.

---

## 17. Ambiguities / contradictions (do not silently resolve)

| Topic | Observation |
|-------|-------------|
| Carrier legal name spelling | Profile/Agreement/MC/W-9/RC/BOL: **I GET AROUND TRANSPORTATION LLC**; COI insured OCR: **I Get Arround Transporation LLC** (typos) |
| Carrier phones | Profile/RC carrier phone **512-270-0406**; Agreement/BOL contact **(209) 849-6647** |
| Carrier emails | Profile **jackdispatch28@gmail.com**; Agreement **DONTAGREEN790@GMAIL.COM** |
| Broker addresses | **121 Frog Hollow Rd, Churchville, PA 18966** vs **91 N YORK RD APT 500-40, Willow Grove, PA 19090** |
| Broker phones | **(267) 703-5313** vs **(484) 929-1404** |
| Agreement title OCR | **PREZIDENT** vs template **PRESIDENT** |
| Willow Grove OCR | **WILLON GROVE** / **ART** vs APT |
| W-9 tax class | **Individual/sole proprietor** checked while Line 2 is **LLC** — REVIEW |
| W-9 Line 1 vs LLC | Individual name vs entity legal name — match policy: prefer businessName to Carrier.legalName |
| Fed ID | Blank on Carrier Profile; EIN on W-9 `42-2248853` |
| Dual insurance PDFs | EOI (8/13/2026) has holder GREEN LOGISTICS LLC; Evidence (5/19/2026) weaker holder evidence |
| Package p12–16 | Broker surety/BMC-84 — **not** carrier authority |
| NOA | Text layer insufficient — vision mandatory |
| Rate Con driver vs dispatch | Derek Wood (broker?) vs Donta Green (carrier contact) — clarify roles in extraction schema |
| Today’s date vs docs | Several 2026 service/policy dates — treat as document truth; expiration vs “now” is runtime |

---

## 18. Missing reference documents

- Official **Green Logistics POD template** (layout) — missing; use business rule for final receiver signature.  
- Standalone clean **Carrier Profile blank template** (only filled package page available).  
- High-quality text layer for **NOA** (image/DocuSign).  
- Explicit **AM Best rating** evidence on COI (rule exists; rating often not printed — REVIEW if unknown).  
- Separate **Workers Comp certificate** example if EL/WC to be strictly enforced beyond COI remarks.

When an official POD template is uploaded later, update this spec (signature region hints only; rules unchanged).

---

## 19. Implementation plan for Phase 2B (recommendation only)

1. Add `CARRIER_PROFILE` to doc-type constants; map INSURANCE↔COI family.  
2. Create tables in §13 via safe additive migration.  
3. Job runner: checksum short-circuit → MIME validate → boundary split → classify (cheap model/text) → extract (text first, vision crops) → signatures multimodal → match → deterministic rules → persist validation → YELLOW queue.  
4. Wire ACL + PII redaction into prompts/logs.  
5. Build review UI split pane.  
6. Implement §16 tests before any production enable flag.  
7. Cost: cache by checksum; avoid full-page vision on digital text PDFs; never reprocess unchanged CURRENT version.

**Out of scope until later phases:** vectors/embeddings, autonomous approve/reject of carriers, master-data mutation, email sending, Attendance/Gmail/CarrierView changes.

---

## 20. Pipeline (architecture reminder)

UPLOAD → FILE VALIDATION → CHECKSUM → TYPE CLASSIFICATION → BOUNDARY DETECTION → OCR/TEXT/VISION → STRUCTURED EXTRACTION → FIELD CONFIDENCE → SIGNATURE DETECTION → GREENOS MATCH → BUSINESS RULES → VALIDATION RESULT → HUMAN REVIEW → FINAL STATUS  

Concepts remain separate: type ≠ extraction ≠ signature ≠ match ≠ rules ≠ final status.

---

## Appendix A — Observed reference identities (for test fixtures)

Use as **example** fixtures only; do not auto-write to production DB from Document AI.

- Carrier: I GET AROUND TRANSPORTATION LLC  
- MC: **1820780** (normalize from MC-1820780-C / MC1820780)  
- DOT: **4575864**  
- Broker: GREEN LOGISTICS LLC · MC **1237784**  
- Load / BOL: **75246**  
- W-9 EIN (masked): `******4853` · full value must not appear in logs  
- COI cargo $100,000 · auto $1,000,000 · holder GREEN LOGISTICS LLC (EOI file)  
- VIN example: 3C63R2CL3JG186769  

---

**STOP — WAIT FOR EXPLICIT APPROVAL BEFORE PHASE 2B.**

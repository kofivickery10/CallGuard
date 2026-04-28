# Data Processing Agreement (DPA)

**Between:**
- **Data Controller:** {{organization_name}} ("the Controller")
- **Data Processor:** CallGuard ("the Processor")

**Effective Date:** {{generated_date}}
**Controller Contact:** {{data_controller_name}} - {{dpo_email}}

---

## 1. Subject Matter and Duration

The Processor will process personal data on behalf of the Controller in connection with the provision of the CallGuard AI call quality assurance service, in accordance with the Controller's documented instructions. This agreement is in force for the duration of the Controller's subscription to CallGuard.

## 2. Nature and Purpose of Processing

- Ingestion, storage, transcription, and evaluation of customer-facing call recordings.
- Generation of compliance scoring reports, breach registers, and trend analytics.
- Delivery of alerts to designated recipients of the Controller.

## 3. Categories of Data Subjects

- Customers / clients of the Controller whose calls are recorded.
- Agents / advisers employed or engaged by the Controller.
- Administrative users appointed by the Controller.

## 4. Categories of Personal Data

See Section 2 of the Controller's DPIA. In summary: audio, transcripts, identifiers, and derived compliance data.

## 5. Processor Obligations

The Processor agrees to:

1. Process personal data only on the documented instructions of the Controller.
2. Ensure persons authorised to process personal data are bound by confidentiality.
3. Implement appropriate technical and organisational security measures (see Annex A).
4. Not engage sub-processors without prior written authorisation of the Controller.
5. Assist the Controller in responding to data subject rights requests (DSARs).
6. Assist the Controller with DPIAs and consultations with supervisory authorities.
7. At the Controller's choice, delete or return all personal data at the end of the services.
8. Make available all information necessary to demonstrate compliance.
9. Notify the Controller of any data breach without undue delay (and in any event within 72 hours of awareness).

## 6. Sub-Processors

The Processor currently uses the following sub-processors:

- **Deepgram, Inc.** - speech-to-text transcription (audio transmitted for processing only; not retained)
- **Anthropic PBC** - AI evaluation of transcripts (text only; not retained)
- **Resend** - transactional email delivery (where email alerts are enabled)

The Controller hereby authorises these sub-processors. The Processor will notify the Controller at least 30 days before engaging any additional sub-processor, giving the Controller the right to object.

## 7. International Transfers

Personal data is stored on UK-based servers. Sub-processors may process data outside the UK; where this occurs, the Processor ensures appropriate safeguards are in place (Standard Contractual Clauses, adequacy decisions, or equivalent).

## 8. Security (Annex A - summary)

- AES-256-GCM encryption at rest
- TLS 1.3 minimum in transit
- Role-based access control with audit logging
- UK Cyber Essentials certification (target)
- Annual penetration testing (target)
- Full audit trail for all compliance actions

## 9. Liability and Termination

Liability and termination provisions are governed by the Controller's subscription terms with the Processor.

## 10. Signatures

**For the Controller:**
Name: {{data_controller_name}}
Role: Data Controller / DPO
Date: {{generated_date}}
Signature: ______________________

**For the Processor:**
Name: (CallGuard authorised signatory)
Role: (Title)
Date: ________________
Signature: ______________________

---

*This template is a starting point and must be reviewed by qualified counsel before execution.*

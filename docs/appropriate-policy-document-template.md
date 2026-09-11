# Appropriate Policy Document

## Special category and criminal offence data: call recording and compliance monitoring

> **What this is, and why you cannot skip it.**
>
> If you rely on a substantial-public-interest condition in **Schedule 1 Part 2
> of the Data Protection Act 2018** — and the insurance condition at paragraph 20
> is one — then **paragraph 5(1)** provides:
>
> > "Except as otherwise provided, a condition in this Part of this Schedule is
> > met only if, when the processing is carried out, the controller has an
> > appropriate policy document in place (see paragraph 39 in Part 4 of this
> > Schedule)."
>
> Paragraph 20 contains no exception. So without this document **the condition
> is not met**, and processing health data on your calls has no Article 9 basis.
> It is not a formality that can be produced after a complaint.
>
> **This is a template, not your policy.** It is pre-completed where the answer
> is about CallGuard's processing and can be stated as fact. Everything in
> **`〔square brackets〕`** is yours. A document that still contains square
> brackets is not in place.
>
> This is a **controller** obligation. CallGuard is your processor and has no
> appropriate policy document duty of its own under Schedule 1 — anyone telling
> you their APD covers you has misunderstood the Act.

| | |
|---|---|
| **Controller** | 〔Firm name〕 |
| **FCA reference** | 〔FRN〕 |
| **ICO registration** | 〔Number〕 |
| **Document owner** | 〔Name, role〕 |
| **Version / date** | 〔1.0 / date〕 |
| **Processing start date** | 〔When call monitoring began or will begin〕 |
| **Next review** | 〔Date — see section 7〕 |

---

## 1. The processing this document covers

〔Describe it in your own words. A sentence or two, not a page.〕

> *Example wording to adapt:* We record inbound and outbound calls between our
> advisers and our customers, and use CallGuard AI to transcribe those
> recordings and assess them against our compliance scorecard. Calls about
> protection and health-based products contain health information disclosed by
> the customer as part of the application process.

**Categories of special category data processed:**

- [ ] Data concerning health 〔the usual one for protection business〕
- [ ] Racial or ethnic origin
- [ ] Religious or philosophical beliefs
- [ ] Trade union membership
- [ ] Genetic data
- [ ] Biometric data for the purpose of uniquely identifying a person
- [ ] Sex life or sexual orientation

**Criminal offence data (Article 10):** 〔Yes / No. Say yes if applications ask
about convictions — some general insurance products do.〕

---

## 2. The conditions relied on

### 2.1 Article 6 basis

〔State it: legal obligation, or legitimate interests. If legitimate interests,
your legitimate interests assessment is at 〔reference〕.〕

### 2.2 Article 9 condition — special category data

**UK GDPR Article 9(2)(g)**, substantial public interest, met through **DPA 2018
Schedule 1 Part 2 paragraph 20 (Insurance)**. Paragraph 20(1) requires that the
processing:

> "(a) is necessary for an insurance purpose, (b) is of personal data revealing
> racial or ethnic origin, religious or philosophical beliefs or trade union
> membership, genetic data or data concerning health, and (c) is necessary for
> reasons of substantial public interest"

〔State how your processing meets each limb. On (a), name which insurance
purpose from paragraph 20(5): advising on, arranging, underwriting or
administering an insurance contract; administering a claim; or exercising a
right or complying with an obligation arising in connection with one.〕

⚠ **If you also write mortgage business, paragraph 20 does not cover it.**
"Insurance purpose" is a closed list and mortgage advice is not on it. Record
separately how monitoring of mortgage calls is justified.

### 2.3 Criminal offence data, if applicable

〔Delete if not applicable.〕 **DPA 2018 Schedule 1 Part 3 paragraph 37**
("Extension of insurance conditions"), which extends paragraph 20 to data that
would meet it but for the requirement that it fall within the categories at
paragraph 20(1)(b).

---

## 3. Procedures for compliance with the Article 5 principles

> Required by **paragraph 39(a)**: this document must explain "the controller's
> procedures for securing compliance with the principles in Article 5 of the UK
> GDPR ... in connection with the processing of personal data in reliance on the
> condition in question."
>
> Note the words **"in reliance on the condition"**. This is not a general data
> protection policy. It is about the special category processing specifically.

### 3.1 Lawfulness, fairness and transparency — Article 5(1)(a)

- The lawful basis and condition are recorded at section 2.
- **Customers** are informed by 〔our privacy notice at URL〕 and by the call
  opening script: 〔quote the wording〕. ⚠ Check the wording covers **all**
  monitored calls, not only those that result in a sale.
- **Advisers** were informed on 〔date〕 by 〔method〕, and new advisers are
  informed at 〔induction / contract stage〕.
- Findings are not used to take a decision affecting an adviser without
  meaningful human review — see 〔your DPIA section 8〕.

### 3.2 Purpose limitation — Article 5(1)(b)

Recordings and their analysis are used for compliance monitoring, adviser
coaching, and responding to complaints and claims disputes. They are **not**
used for 〔state what you exclude — e.g. performance-related pay decisions,
marketing, or general staff surveillance〕.

〔If you do use them in pay or disciplinary processes, say so. An APD that
understates the purpose is worse than one that admits an uncomfortable one.〕

### 3.3 Data minimisation — Article 5(1)(c)

- Only calls 〔all / for these product lines / for these teams〕 are ingested.
- **Personal data is removed during transcription by default.** CallGuard
  applies redaction at source, so names, addresses, dates of birth, health terms
  and payment details are replaced with typed markers before the transcript is
  stored or passed to any AI model.
- Payment card and bank details are **never** retained in readable form. This is
  enforced by the platform and cannot be switched off by configuration.
- 〔**If you have asked for any category to be left readable, say so here, name
  the categories, and state who authorised it and when.** This is the single
  most important line in this document for a firm in that position. If you have
  not, write "No redaction categories are disabled."〕

### 3.4 Accuracy — Article 5(1)(d)

- Findings carry the evidence they are based on — the checkpoint, a quote from
  the call, the source recording and the point in it — so they can be checked
  rather than taken on trust.
- Where the AI's confidence is low on a consent-related checkpoint, the item is
  routed to a person instead of being scored automatically.
- An adviser who disputes a finding may 〔state the route〕, and a finding can be
  overridden by 〔role〕. Overrides are recorded.
- 〔Note: speaker attribution — which party said what — is determined
  automatically and carries a confidence score. Where a call is single-channel
  the attribution is inferred. Consider this when a finding turns on who spoke.〕

### 3.5 Storage limitation — Article 5(1)(e)

See section 4, which is the paragraph 39(b) policy.

### 3.6 Integrity and confidentiality — Article 5(1)(f)

The following are properties of the CallGuard platform and can be stated as
fact:

- Call audio and stored documents are encrypted at rest using AES-256-GCM.
- Integration credentials are encrypted with the same scheme.
- Data is encrypted in transit, including a certificate-verified connection to
  the database.
- Access is scoped to our organisation; no other firm's users can reach it.
- Roles are enforced by the platform. **Advisers can see only their own calls.**
- Where a redaction category is left readable, **only the `admin` role can read
  a transcript** — every other role has it withheld entirely rather than
  partially masked.
- Where a redaction category is left readable, quotes from calls are **withheld
  from every export**: emails to advisers, our CRM, downloaded files and
  integrations.
- Two-factor authentication is available and 〔is / is not〕 enforced for our
  users.
- Actions in the platform are logged with the user and the time.

Our own measures:

- Who holds the `admin` role: 〔names or roles — keep this short list short〕
- Device and password policy: 〔reference〕
- Training: 〔what, and how often〕
- Leaver process: 〔how access is removed, and how quickly〕
- Breach response: 〔who to tell, and the 72-hour reporting route〕

### 3.7 Accountability — Article 5(2)

- Our DPIA for this processing: 〔reference and date〕
- Our Article 30 record: 〔reference〕 — see section 6 for what Schedule 1
  paragraph 41 adds to it
- The processing agreement with CallGuard: 〔reference and date〕

---

## 4. Retention and erasure policy

> Required by **paragraph 39(b)**: this document must explain "the controller's
> policies as regards the retention and erasure of personal data processed in
> reliance on the condition, **giving an indication of how long such personal
> data is likely to be retained**."
>
> That last clause means a number. "As long as necessary" does not satisfy it.

| Data | Retained for | Then |
|---|---|---|
| Call recordings | 〔 〕 years | Deleted automatically |
| Transcripts | 〔 〕 years | Deleted with the call |
| Scores and compliance findings | 〔 〕 years | Deleted with the call |
| Extracted application answers, if used | 〔 〕 days | Deleted automatically |
| Records of adviser feedback and acknowledgement | 〔 〕 years | 〔 〕 |

**How erasure actually happens.** CallGuard runs an automatic daily sweep
against the retention period we have set. Recordings older than that period have
the audio file deleted and the call record removed, and the scores and findings
attached to it are deleted with it. Deletion is not dependent on anyone
remembering to do it.

**On termination.** If we stop using CallGuard, all of our data is purged within
30 days of the contract ending.

**Erasure on request.** A customer's erasure request is actioned against their
record, and the calls, transcripts, scores and findings keyed to it are deleted.
〔State who handles these and the internal deadline you work to.〕

**Justification for the period chosen.** 〔Why this number? Tie it to your
record-keeping obligations. If you have chosen the platform default rather than
a considered period, choose one now — a default is not a policy.〕

---

## 5. Retention, review and availability of this document

> **Paragraph 40** requires that during the relevant period the controller must
> "(a) retain the appropriate policy document, (b) review and (if appropriate)
> update it from time to time, and (c) make it available to the Commissioner, on
> request, without charge."
>
> The **relevant period** begins when the processing starts and ends **"at the
> end of the period of 6 months beginning when the controller ceases to carry
> out such processing"** — so this document must be kept for six months after
> you stop, not destroyed along with the data.

- **Retained by:** 〔name/role〕 at 〔location〕
- **Reviewed:** at least annually, and on any material change — in particular
  a change to redaction settings, retention periods, who holds `admin`, or the
  products in scope.
- **Available to the Information Commissioner on request, without charge:**
  requests to 〔name, contact〕.

| Version | Date | Author | What changed |
|---|---|---|---|
| 1.0 | 〔 〕 | 〔 〕 | First version |

---

## 6. Record-keeping under Schedule 1 paragraph 41

Paragraph 41 supplements your **Article 30** record for this processing. It
belongs in that record rather than here, but it is reproduced as a checklist
because it is easy to miss:

- [ ] Which Schedule 1 condition is relied on
- [ ] How the processing satisfies **Article 6** (lawfulness)
- [ ] Whether the data is retained and erased in accordance with the policies in
      section 4 above — **and if it is not, the reasons why not**

That last item is the one with teeth: it requires you to record your own
non-compliance if your practice has drifted from your policy. Check section 4
describes what actually happens rather than what was intended.

*〔Verify paragraph 41's exact wording against legislation.gov.uk before quoting
it verbatim anywhere — the summary above is reliable in substance but was not
confirmed word-for-word.〕*

---

## 7. Sign off

| | |
|---|---|
| Approved by | 〔Name, role — someone with authority, not the person who drafted it〕 |
| Date | |
| Next review due | |

---

*Template provided by CallGuard AI. It is a starting point drafted from the
statutory requirements, not legal advice, and it does not become your policy
until you have completed it and someone in your firm has approved it. Statutory
wording quoted above was taken from legislation.gov.uk; the citations are
recorded in CallGuard's `regulatory-citations-verified.md`.*

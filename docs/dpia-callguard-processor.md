# Data Protection Impact Assessment

## CallGuard AI: AI compliance scoring of recorded advice and sales calls

| | |
|---|---|
| **Assessment covers** | The CallGuard AI platform as a whole — ingesting recorded calls from a firm's telephony, transcribing them, scoring them against the firm's own compliance scorecard, and surfacing findings to the firm and its advisers. It does **not** re-assess the Data Forms reconciliation module, which has its own assessment (`dpia-data-forms-reconciliation.md`, currently 0.4) and is referenced rather than repeated here. |
| **Prepared by** | CallGuard AI |
| **Role** | **Processor** for the call content described here. Controller for the account data described in section 2.3. |
| **Version** | 0.1, draft |
| **Date** | 10 September 2026 |
| **Status** | **DRAFT. Not signed.** Written to be checked, not believed: every claim about the product is a claim about code that can be read, and section 12 lists what has not been verified. |
| **Review due** | 12 months from sign-off, or on any material change to the processing |

### Why this exists at all, given it is the controller's duty

A DPIA for this processing is the **firm's** obligation, not ours. We are the
processor. But Article 28(3)(f) requires us to *assist* the controller with
DPIAs, and a twelve-person brokerage with no data protection officer has to
produce one and in practice cannot. So there are two documents:

1. **This one** — what CallGuard actually does with personal data, written from
   the code, so a controller's own DPIA can rely on it instead of guessing.
2. **A pre-completed DPIA template** for the controller
   (`dpia-template-controller.md`), with the health-data and AI sections already
   drafted, plus a model appropriate policy document
   (`appropriate-policy-document-template.md`).

The second pair is what a firm signs. This one is what makes the second pair
honest.

---

## 1. Why an assessment is required

Article 35(1) UK GDPR requires a DPIA where a type of processing "is likely to
result in a high risk to the rights and freedoms of natural persons". Article
35(3) makes one mandatory in three listed cases. **Two of the three apply
squarely here**, and it is worth being precise about which, because the third is
commonly and wrongly claimed:

- **Article 35(3)(b) — "processing on a large scale of special categories of
  data referred to in Article 9(1)".** Protection and health cover calls contain
  health disclosures: conditions, medication, smoking status, alcohol
  consumption, family history. That is Article 9 data and it is the subject
  matter of the call, not an incidental mention.
- **Article 35(3)(a) — "a systematic and extensive evaluation of personal
  aspects relating to natural persons which is based on automated processing,
  including profiling, and on which decisions are based..."** Every call an
  adviser takes is transcribed, scored and attributed to them by name.

**Article 35(3)(c) does not apply.** It covers "systematic monitoring of a
**publicly accessible area** on a large scale". Employee monitoring is not that,
and citing (c) for it is an error a compliance officer will find immediately.
The employee-monitoring argument is a high-risk argument under Article 35(1) and
ICO guidance, not a 35(3) case.

Beyond the mandatory cases, the processing is high risk under 35(1) on several
further grounds: it produces **evaluation and scoring** of individuals; it can
lead to a **detriment** for an adviser (commission, coaching, in the extreme
their job); it uses **innovative technology**; and the adviser is arguably a
**vulnerable data subject** by virtue of the employer/worker power imbalance.

*ICO's published high-risk criteria are referred to here in substance rather
than quoted. ICO's site blocks automated retrieval, so nothing attributed to ICO
in this document has been verified verbatim — see section 12.*

---

## 2. Roles

### 2.1 The firm is the controller

The firm decides that calls are recorded, which calls are ingested, what the
scorecard asks, who inside the firm may see what, how long recordings are kept,
and what happens to an adviser when a finding is raised. Those are the decisions
that make someone a controller, and CallGuard makes none of them.

### 2.2 CallGuard is the processor

We act on the controller's documented instructions, expressed partly through the
contract and partly through the per-tenant configuration described throughout
this document. Where a setting materially changes the privacy position — keeping
a redaction category in the clear, choosing a transcription region, setting a
retention period — it is a controller decision that we implement, and section 4
says which settings those are.

### 2.3 CallGuard is a controller for its own account data

Names, email addresses, roles and login credentials of the firm's users; audit
records of what those users did in the platform; and billing data. This is
ordinary business-contact processing under Article 6(1)(b) and (f) and is not
the subject of this assessment, but it is stated so the boundary is not
ambiguous. Superadmin (CallGuard staff) access to tenant data is covered at 9.4.

### 2.4 Who the data subjects are

Two distinct groups, with different interests, and conflating them is a mistake:

| | Customer | Adviser |
|---|---|---|
| Data | Health, financial and identity disclosures made on the call | Name, performance, compliance findings against them |
| Relationship to the firm | Customer | Employee or contractor |
| Can they refuse? | In principle, by not proceeding | Not meaningfully |
| Main risk | Exposure of a health disclosure | Unfair judgement, employment consequence |

Most of this document protects the first. Sections 5.4, 8 and 9.5 exist for the
second, whose interests are easier to overlook precisely because they are not
the subject of the disclosure.

---

## 3. What the processing does

### 3.1 The pipeline

A call reaches CallGuard by one of three routes: a recurring SFTP poll of the
firm's recording store, a dialler webhook (CloudTalk is the primary), or a CRM
sale trigger. From there:

1. **Hydrate.** The audio is fetched and stored, encrypted (9.1).
2. **Transcribe.** Deepgram `nova-3`, with diarisation and **redaction applied
   at source** — personal data is replaced with typed tags such as
   `[PII_NAME_1]` or `[PHI_...]` before the transcript is written to storage or
   passed to any model. Section 4 covers the exception a firm can request.
3. **Clean up.** A small Claude model corrects mishearings and, where speaker
   attribution was uncertain, checks who was speaking.
4. **Score.** A Claude model evaluates the transcript against the firm's
   scorecard, returning a verdict, a confidence and a supporting quote per
   criterion. Low-confidence items on consent-type criteria are routed to a
   **human review queue** rather than auto-scored (8.2).
5. **Surface.** Findings appear in the platform, and may be sent to the adviser
   by email, written back to the firm's CRM, or delivered to a webhook the firm
   configures. Section 7 covers what may and may not leave.

### 3.2 Per-call and per-sale

A firm scores either every call individually, or scores a **sale** — several
calls with one customer, assessed as a single compliance unit. The mode is a
per-tenant setting. It changes what a finding is *about* but not what personal
data is processed.

### 3.3 What the model is given

The scoring model receives the **redacted** transcript, the firm's scorecard
text, and optionally the firm's own knowledge-base excerpts and past human
corrections. It does not receive the audio, the customer's CRM record, or any
data from another tenant. Where a firm has asked for a category to be left
unredacted, the model receives that category in the clear — which is the point
of the exception and its principal risk (4.2).

---

## 4. The setting that changes everything: redaction

### 4.1 The default

Every redaction category is applied at source. Health, names, addresses,
payment data, dates of birth and phone numbers are typed tags by the time
anything is stored. A transcript at the default setting contains no readable
personal data, which is why almost everything else in this document is
comfortable.

### 4.2 The exception, and why it exists

A firm may ask for named categories to be left in the clear. This is not a
convenience: reconciling what a customer said against what an insurer was told
cannot be done on `[PHI_3]`, and the Data Forms assessment establishes
empirically that redaction was also degrading the compliance analysis the firm
pays for.

Two profiles, two different legal bars, and the distinction is real rather than
theoretical:

| Profile | Categories in the clear | What the controller needs |
|---|---|---|
| **None** (default) | — | Article 6 only |
| **Identity** | name, date of birth, address, email | Article 6 only |
| **Full** | the above plus health | **Article 9 condition + appropriate policy document** |

Payment data is excluded structurally rather than by convention: it cannot be
permitted, and in addition CallGuard operates its own bank-detail redaction on
every transcript regardless of the firm's configuration, so a configuration
change cannot switch it off.

### 4.3 What the exception triggers

Enabling any category is a controller decision with consequences that this
document ties together in one place, because they are easy to meet
individually and miss collectively:

- **Reading a transcript is restricted to the `admin` role**, enforced at the
  API, for any firm keeping a category in the clear. Every other role gets the
  transcript withheld in full rather than partially masked — a partial
  redaction that presents as complete is worse than none, because nobody knows
  to distrust it.
- **Nothing leaves carrying a quote from the call** (section 7).
- **The model's reasoning is withheld from the adviser feedback email** where
  health is in the clear.
- The **Data Forms assessment** applies in full, including its unclosed risks.

### 4.4 Other settings with a privacy dimension

| Setting | Default | Why it matters here |
|---|---|---|
| `deepgram_region` | `eu` | `us` moves voice data outside the UK/EU — see 6.2 |
| `retention_days` | 5 years | Section 8 |
| `captured_retention_days` | 90 days | Shorter clock for extracted answers |
| `scoring_scope` | sales only | Whether every call is scored or only sales |
| `review_confidence_floor` | per tenant | How much goes to a human instead of the model |
| `pii_unredacted_categories` | empty | Section 4.2 — the significant one |

---

## 5. Data categories

| Category | Examples | Where it lives | Article 9? |
|---|---|---|---|
| Call audio | The recording itself | Encrypted on the application host | Contains Article 9 content |
| Transcript | Text of the call, redacted unless 4.2 applies | Database | Yes, where 4.2 applies |
| Health and lifestyle disclosures | Conditions, medication, smoking, alcohol, height/weight, family history | Redacted by default; readable under the Full profile | **Yes** |
| Identity data | Name, date of birth, address | Redacted by default; readable under Identity or Full | No |
| Contact data | Telephone number, email | Phone is held in the clear on the call record for matching, independently of redaction | No |
| Payment data | Card and bank details | **Never permitted**, plus an in-house control (4.2) | No |
| Adviser data | Name, team, scores, findings, coaching | Database | No |
| Scoring output | Verdict, confidence, a quote from the call, the model's reasoning | Database | Takes the character of what it quotes |
| Audit records | Who did what in the platform, and when | Database | No |

**The quote is the thing to watch.** The scoring model is asked for a direct
quote from the transcript as evidence, so a finding's evidence field carries the
customer's own words. Under the default profile those words contain typed tags
and nothing more. Under the Full profile they can be a health disclosure
verbatim. Section 7 is about that field.

---

## 6. Sub-processors and international transfers

### 6.1 The list

| Sub-processor | What it does | Data it sees |
|---|---|---|
| **Deepgram** | Speech-to-text | Call audio |
| **Anthropic** | Transcript cleanup and compliance scoring | Transcript text (redacted unless 4.2) |
| **Resend** | Transactional email | Recipient address, and the email body — which is why section 7 governs what the body may contain |
| **AWS** | Managed Postgres | All stored data |
| **Cloudflare** | TLS termination and edge | Traffic in transit |

Zoho and CloudTalk are **the firm's own** systems, not our sub-processors. We
write to them on the firm's instruction using the firm's credentials, and
section 7 governs what we write.

### 6.2 Transfers

> **The transfer regime changed on 5 February 2026.** Article 45 UK GDPR was
> **omitted** by the Data (Use and Access) Act 2025 (s.142(1), Sch. 7 para. 3).
> Adequacy now runs through the new **Articles 45A and 45B**. Article 45B(1)
> sets the test: the standard of protection in the third country must be **"not
> materially lower"** than the UK standard — which is a deliberate divergence
> from the EU's "essentially equivalent" test and should not be described as
> the same thing.

**Where the data goes:**

- **Deepgram** is called at its **EU endpoint by default**, so audio is sent to
  the EU rather than the US. A per-tenant setting can move a firm to the US
  endpoint; a controller who selects it is authorising a transfer to the US and
  must record it in their own assessment.
- **Anthropic** is US-based with no regional option in our integration.
  Transcript text is transferred for every scored call.
- **AWS** — region unverified, see section 12.

**The route we expect to rely on for the US, and what it requires of us.** The
UK–US Data Bridge remains in force: the Data Protection (Adequacy) (United
States of America) Regulations 2023 were made under DPA 2018 s.17A, and DUAA
2025 **Sch. 9 para. 26** provides that such regulations are treated as if made
under Article 45A. So the repeal of Article 45 did not take the data bridge with
it.

But **adequacy is not country-wide, and this is where firms get it wrong.** It
covers only transfers to organisations on the Data Privacy Framework List that
participate in the **UK Extension** specifically. A US company can be
DPF-certified for the EU alone. So for each US recipient we must confirm, and
re-confirm at each annual recertification:

1. the certification is active;
2. it **expressly includes the UK Extension**, not the EU framework only;
3. it covers the relevant data categories.

**That check has not been done for Deepgram or Anthropic.** Until it has, the
transfer position is unestablished rather than satisfied — action 2 in section
12. The fallback routes if a recipient is not UK-Extension certified are the
Commissioner's standard clauses under DPA 2018 s.119A (the IDTA and the UK
Addendum, both preserved by Article 46(2)) or binding corporate rules, and
either would require our own assessment against the "not materially lower"
standard.

### 6.3 The no-training position

**Deepgram.** Call audio is not retained for or used in model training. The
opt-out is sent on **every** transcription request on both the batch and the
streaming path, is hardcoded rather than configured, and there is no setting or
UI path that can turn it off. It costs us the discount that comes with allowing
training, which is the point.

*A per-tenant column exists in the schema that appears to make this
configurable. It is read into the settings object and then never used — the
request always opts out. The code is safer than the configuration suggests, but
the dead setting should be removed so that nobody reads it as a toggle. Recorded
as action 6.*

**Anthropic.** Our position is that inputs submitted through the commercial API
are not used to train models. **This is a contractual claim, not something our
code enforces, and it is listed in section 12 as requiring verification against
the current terms before this document is given to a customer.**

---

## 7. What leaves the platform

Four routes take content out of the controlled environment: email to an adviser,
the firm's CRM, a webhook the firm configures, and file downloads. A fifth, the
claims-defence pack, is dealt with separately at 7.3.

### 7.1 The rule

Where a firm keeps a category in the clear, **a quote from the call does not
leave**. What leaves is the checkpoint that was failed, its severity, and a link
back into CallGuard. The withholding is applied at each point of exit rather
than where the payload is assembled, so a route added later inherits it, and the
copy kept for delivery retry is the withheld copy.

Where anything is withheld the recipient is told so — in words on the surfaces a
person reads, and as a field for machine consumers. A shortened list that says
nothing is indistinguishable from a call the model found nothing to quote on,
and that is a false impression rather than a neutral one.

### 7.2 Two thresholds, and the difference is the destination

- To the **firm's own CRM**: withheld where the firm keeps **health** in the
  clear. The CRM is the firm's customer record and already holds the customer's
  name and address, so withholding a quote there because it might contain a name
  would protect nothing.
- To **anywhere else** — a webhook endpoint, a downloaded file, an API client:
  withheld where the firm keeps **any** category in the clear, because none of
  those is a system this assessment can say anything about.

### 7.3 Where a quote still leaves, deliberately

The **claims-defence pack** is generated per sale, on request, when an insurer
declines a claim or a customer complains. It carries the quotes, and continues
to: what the customer disclosed is the subject matter of that document, and a
pack without it would not do its job. It is restricted to admin, supervisor and
viewer, is produced on request rather than pushed, and its disclosure is the
controller's decision on each occasion.

This is stated rather than implied, so that "quotes do not leave" is never read
as broader than it is.

### 7.4 What the adviser's email contains

The adviser is emailed the checkpoints they failed, the score, the verdict, and
any remediation guidance the firm has written. Where the firm keeps health in
the clear, the **model's reasoning is withheld** and the email says so. The
email names the client so the adviser can tell one sale from another, but the
subject line does not — a subject renders on a lock screen.

---

## 8. Necessity, proportionality, and the adviser

### 8.1 Necessity

The firm has a regulatory obligation to monitor advice quality. It can meet it
by having a supervisor listen to a sample of calls, which in practice means
one or two per adviser per month, or by scoring all of them automatically. The
second is more intrusive per call and considerably less intrusive per finding:
it removes the need for a human to listen to calls that turn out to be fine.

### 8.2 The model does not decide anything about a person

> **Article 22 no longer exists.** It was omitted and replaced by Articles
> 22A–22D (Chapter 3, Section 4A) by the Data (Use and Access) Act 2025 s.80(1),
> fully in force **5 February 2026**. Any document still citing "Article 22(1)"
> is out of date. The change helps us: what used to be a guidance gloss is now
> statutory text.

**Article 22A(1)(a)** defines the term directly: *"a decision is based solely on
automated processing if there is no meaningful human involvement in the taking
of the decision"*. So the test is not whether software was involved. It is
whether a person meaningfully was.

Compliance findings are **decision support**. Three things hold that line, and
all three are in the product rather than in policy:

- Every finding carries its evidence — the criterion, a quote, the source call
  and the point in the recording — so a person can check it.
- Low-confidence items on consent-type criteria are routed to a **human review
  queue** instead of being auto-scored, so a false pass is not produced by
  guessing.
- The action that affects an adviser — feeding a finding back to them — is a
  supervisor pressing a button, not an automatic consequence of the score.

**Two limits on that argument, stated because they are load-bearing.**

*"Meaningful" is doing all the work, and it is undefined.* Article 22D(1) lets
the Secretary of State define meaningful human involvement by regulations, and
none are in force. A human who rubber-stamps a list of findings is not
meaningful involvement, and no amount of product design makes it so.

*Article 22B bites harder than the old Article 22 did.* Where a significant
decision is based entirely or partly on Article 9(1) data, it **may not** be
taken solely by automated means except on explicit consent or a contract/legal
route plus Article 9(2)(g). Our scoring routinely processes health data. So on a
firm that lets a finding drive a consequence without human involvement, the
prohibition is stricter here than for ordinary data — not looser.

**This is therefore a contractual requirement on the controller, not a fact
about our software.** The product supports human review and cannot enforce it
inside a firm.

**Action for the controller:** confirm and document that no action affecting an
adviser's employment or pay follows from a finding without meaningful human
review.

*ICO's guidance on automated decision-making is currently in draft
(consultation closed 29 May 2026, final due Winter 2026). It is deliberately not
relied on here.*

### 8.3 The risk of being wrong about an adviser

A false finding is an implied allegation that an adviser did not do their job.
Mitigations: the evidence quote is always shown; human corrections are recorded
and fed back into future scoring; a firm can override a finding and the override
is itself recorded; and multiple independent scoring passes can be required for
firms that want them.

---

## 9. Technical and organisational measures

### 9.1 At rest and in transit

- Call audio and stored documents are encrypted with **AES-256-GCM** on the
  application host. The scheme carries a key id, so a key can be rotated without
  losing the ability to read what was written under the previous one.
- Per-tenant integration credentials (CRM tokens, dialler secrets, webhook
  signing secrets) are encrypted with the same scheme.
- TLS in transit throughout, including a **verified** TLS connection to the
  database using the provider's CA bundle rather than a blind trust.
- *A historical flag exists on stored files indicating whether a file was
  written before encryption was enabled. Whether any such files remain is listed
  in section 12 as unverified — it is a question of fact about production data,
  not about the code.*

### 9.2 Access control

- Every query is scoped to the tenant's organisation.
- Roles: `admin`, `supervisor`, `viewer`, `adviser`, plus platform `superadmin`.
  **Advisers are scoped to their own calls** and cannot reach org-wide views.
- Short-lived access tokens with separate refresh tokens.
- TOTP two-factor authentication.
- Unredacted transcripts are restricted to `admin` where 4.2 applies (4.3).

### 9.3 Audit

Actions in the platform — status changes, notes, overrides, feedback sent and
acknowledged, configuration changes — are recorded with the actor and the time.

### 9.4 CallGuard staff access

Platform staff can access tenant data through a separate superadmin console in
order to support the product. This is processor access under the processing
agreement rather than under the firm's internal role policy, and it should be
stated plainly to a controller rather than left to be discovered. **Action 7:
state the controls on that access — who has it, how it is logged, and how a
controller can ask what was accessed.**

### 9.5 Data subject rights

- **Access and erasure** operate against the customer record, and a deletion
  cascades to the calls, scores and findings keyed to it.
- Retention is enforced by an automatic daily sweep rather than by anyone
  remembering (section 8 of the Data Forms assessment; timings at 10 below).
- **Action 8:** confirm that a subject access response includes the scoring
  output and the reconciliation record, not only the recording and transcript.

---

## 10. Retention and deletion

A daily sweep applies, per tenant:

| Stage | Default | What happens |
|---|---|---|
| Archive | 2 years | Hidden from the working view; data retained |
| Purge | 5 years (`retention_days`) | Audio file deleted, call row deleted, scores and findings cascade |
| Captured answers | 90 days (`captured_retention_days`) | Shorter clock for extracted answer data |
| Termination | 30 days after cancellation | Everything purged |

Five years aligns with the record-keeping obligations a firm is working to. The
controller sets the number; the default is not a recommendation.

---

## 11. Risks and mitigations

### P1. A health disclosure is exposed to someone inside the firm who should not see it

**Inherent: medium likelihood, high impact**, and only where 4.2 applies.
Mitigations: the `admin`-only restriction on unredacted transcripts, enforced at
the API; withholding in full rather than masking; per-role scoping; audit.
**Residual: low.**

### P2. A quote from the call leaves the platform

**Inherent: medium likelihood, high impact.** This risk was realised: quotes
were reaching CRMs, webhooks, downloads and an API before the control at
section 7 existed. The control now exists at every exit and is covered by test.
What had already left before it existed is a question of fact, recorded as
action 5 rather than assumed either way.
**Residual: low**, except the deliberate claims-defence route (7.3).

### P3. An adviser is treated unfairly on a wrong finding

**Inherent: medium likelihood, medium impact.** Mitigations at 8.2 and 8.3.
**Residual: low likelihood, medium impact**, and dependent on a firm process we
cannot enforce — hence the action at 8.2.

### P4. A sub-processor retains or trains on call content

**Inherent: low likelihood, high impact.** Mitigation for Deepgram is
unconditional and in code (6.3). For Anthropic it is contractual and
**unverified in this draft** (section 12).
**Residual: cannot be stated until action 1 is done.**

### P5. Data is transferred outside the UK without a lawful basis

**Inherent: medium likelihood, medium impact.** Audio stays in the EU by
default; transcripts reach a US model provider on every scored call.
**Residual: cannot be stated until actions 2 and 3 are done.** This is the
weakest part of this draft and is not dressed up as anything else.

### P6. One tenant's data reaches another

**Inherent: low likelihood, very high impact.** Organisation scoping on every
query; per-tenant credentials; caches keyed by organisation rather than by
shared attributes.
**Residual: low.** **Action 9: verify the isolation rather than assert it.**

### P7. The model invents a quote or a finding

**Inherent: medium likelihood, low-to-medium impact.** Evidence is quoted with a
timestamp so it can be checked against the recording; low-confidence items go to
a human; a truncated model response is never allowed to silently replace a
transcript.
**Residual: low.**

---

## 12. What this draft does not establish

Listed rather than smoothed over. A DPIA that reads as complete when it is not
is worse than one that says where it stops.

| # | Not established | Needed before |
|---|---|---|
| 1 | Anthropic's current commercial terms on training and retention, quoted from source | Giving this to any customer |
| 2 | Whether Deepgram and Anthropic are on the DPF List **participating in the UK Extension** — not the EU framework alone (6.2) | Same |
| 3 | The AWS region holding the database | Same |
| 4 | Whether the Deepgram EU endpoint keeps data in the EU end to end, or only at the point of ingress | Same |
| 5 | What call content reached CRMs, webhooks and downloads before the section 7 control existed | A conversation with any affected firm |
| 6 | Removal of the dead per-tenant training-opt-out setting (6.3) | Not blocking, but it misleads |
| 7 | The controls on CallGuard staff access (9.4) | Giving this to any customer |
| 8 | Whether subject access includes scoring output (9.5) | Sign-off |
| 9 | Verified tenant isolation (P6) | Sign-off |

**On citations.** Every statutory reference in this document has been checked
against the primary text on legislation.gov.uk and is recorded with its URL in
`regulatory-citations-verified.md`. That check found four errors in the working
draft, three of them the kind a compliance officer finds in the first
five minutes: Article 22 has been replaced by Articles 22A–22D, Article 45 has
been omitted in favour of 45A/45B, Article 35(3)(c) is about publicly accessible
areas rather than employee monitoring, and the insurance condition does not
reach criminal-offence data.

**Nothing attributed to the ICO in this document has been verified verbatim.**
ICO's site blocks automated retrieval, so ICO positions are stated in substance
and should be read against the source before any of them is quoted to a
customer.

---

## 13. Sign off

| | |
|---|---|
| Prepared by | |
| Date | |
| Reviewed by | |
| Next review | |

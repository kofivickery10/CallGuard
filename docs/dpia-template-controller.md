# Data Protection Impact Assessment

## Monitoring recorded advice and sales calls for compliance

> **How to use this document.**
>
> This is **your** assessment. You are the controller: you decide that calls are
> recorded, whose calls are monitored, what the scorecard asks and what happens
> when something is flagged. CallGuard is your processor and cannot make those
> decisions for you.
>
> What we have done is complete the parts that are about **our** processing —
> what the platform does, who it sends data to, where it goes, how long it is
> kept and how it is secured — because those are the parts you would otherwise
> have to reverse-engineer. Everything in **`〔square brackets〕`** is yours to
> fill in or confirm. Everything marked **⚠ Decide** is a judgement only you can
> make.
>
> Do not sign it without reading it. A DPIA that was filled in by a supplier and
> signed unread is not a DPIA; it is a liability with a signature on it. If you
> disagree with anything we have written about our own processing, tell us —
> that is the useful outcome, not the awkward one.
>
> The underlying detail is in our own assessment, `CallGuard AI: AI compliance
> scoring of recorded advice and sales calls`, which we will give you on request
> and which this document cites rather than repeats.

| | |
|---|---|
| **Controller** | 〔Firm name, FCA reference number〕 |
| **Assessment covers** | Recording, transcription and automated compliance scoring of advice and sales calls, and the use of the results in supervision. |
| **Prepared by** | 〔Name, role〕 |
| **DPO or responsible person** | 〔Name — or record that you have assessed that no DPO is required and why〕 |
| **Processor** | CallGuard AI |
| **Version / date** | 〔0.1 / date〕 |
| **Status** | 〔Draft / signed〕 |
| **Review due** | 12 months from sign-off, or on any material change |

---

## 1. Why we are doing a DPIA

A DPIA is required where processing is likely to result in a high risk to
individuals. This processing engages at least three of the ICO's screening
criteria, so the question is not really arguable:

- **Special category data.** Protection and health cover calls contain health
  disclosures — conditions, medication, smoking, alcohol, family history. That
  is the subject of the call, not an accident.
- **Systematic monitoring of employees.** Every adviser's calls are transcribed
  and scored, and results attach to them by name.
- **Innovative technology.** The scoring is done by AI.

The processing also produces **scoring of individuals** and can lead to a
**detriment** for an adviser, which are two further criteria.

〔If any of the above does not apply to you — for example if you do not sell
health-based products, so no Article 9 data arises — say so here and adjust
section 4 accordingly. Do not delete a criterion just because it is
inconvenient.〕

---

## 2. What the processing is

### 2.1 What happens to a call

1. The recording reaches CallGuard from 〔our telephony system / recording
   store / CRM — name it〕.
2. It is transcribed automatically. **Personal data is removed during
   transcription** and replaced with typed markers such as `[NAME]` or
   `[HEALTH]`, before the transcript is stored or shown to any AI model —
   unless we have asked for an exception, see 4.3.
3. The transcript is scored against **our own compliance scorecard**, which we
   wrote. Each checkpoint gets a verdict, a confidence level and a quote from
   the call as evidence.
4. Results appear in CallGuard for 〔which roles〕. Findings may be emailed to
   the adviser, written to our CRM, or sent to 〔any other system〕.
5. Where the AI is not confident on a consent-related checkpoint, the item is
   put in a **human review queue** rather than being scored automatically.

### 2.2 Whose data

| | Customers | Advisers |
|---|---|---|
| What we process | What they said on the call, including health and financial information | Their name, their calls, their scores and any findings against them |
| Volume | 〔approx. calls per month〕 | 〔number of advisers〕 |
| Their relationship to us | Customer | Employee / contractor |

### 2.3 Scale and duration

〔Calls per month; how many advisers; whether this covers all calls or a defined
subset; when it started or will start; whether it is permanent.〕

---

## 3. Consultation

〔Record who you consulted. The ICO expects you to consult data subjects or
their representatives where appropriate. For employee monitoring that normally
means telling advisers and giving them a route to raise concerns — and it is
worth doing on its own merits, not only because it is expected. Note what they
said and what you changed, if anything.〕

- Advisers / staff representatives: 〔date, outcome〕
- DPO or adviser: 〔date, outcome〕
- Customers: 〔normally via the privacy notice rather than direct consultation —
  say which〕

---

## 4. Lawful basis

> This is the section most firms get wrong, and the one where getting it wrong
> matters most. You need **two** bases if health data is involved: one under
> Article 6 for the processing generally, and a **separate** condition under
> Article 9 for the health data specifically. Consent is almost never the right
> answer for either.

### 4.1 Article 6 — the general basis

⚠ **Decide.** The usual candidates:

- **Legal obligation** — where a rule requires you to monitor advice quality.
  Cite the rule.
- **Legitimate interests** — ensuring good customer outcomes and meeting your
  regulatory responsibilities. If you rely on this you must complete a
  **legitimate interests assessment**, and it must genuinely weigh the
  adviser's interest in not being monitored, not merely record that you
  considered it.

〔State which, and why.〕

### 4.2 Article 9 — the condition for health data

⚠ **Decide, and only if health data actually arises.**

If your calls contain health disclosures, an Article 6 basis is **not enough**.
You need a separate condition under Article 9(2). For an insurance intermediary
the route is normally Article 9(2)(g), substantial public interest — and **DPA
2018 s.10(3)** provides that Article 9(2)(g) is met "only if it meets a
condition in Part 2 of Schedule 1".

**The insurance condition, DPA 2018 Schedule 1 Part 2 paragraph 20**, is met
where the processing:

> "(a) is necessary for an insurance purpose, (b) is of personal data revealing
> racial or ethnic origin, religious or philosophical beliefs or trade union
> membership, genetic data or data concerning health, and (c) is necessary for
> reasons of substantial public interest"

**"Insurance purpose" is a closed list** (para 20(5)): advising on, arranging,
underwriting or administering an insurance contract; administering a claim; or
exercising a right or complying with an obligation arising in connection with
one.

⚠ **Two traps, both of which catch firms doing mixed business.**

- **Mortgage advice is not an insurance purpose.** If you do both mortgage and
  protection business, paragraph 20 covers the protection side only. You need a
  separate analysis for mortgage calls — do not let one condition carry both.
- **Paragraph 20 does not cover criminal-offence data** (Article 10). Its
  limb (b) lists Article 9 categories only. If your calls capture criminal
  convictions — a general insurance application may — the route is **Schedule 1
  Part 3 paragraph 37**, "Extension of insurance conditions", cited separately.

There is **no general "consent is not required" dispensation** in paragraph 20,
and it is sometimes described as though there were. Sub-paragraphs (2)–(4) deal
with a narrower situation — third parties who have no rights or obligations
under the contract — and there they *add* a requirement that the processing "can
reasonably be carried out without the consent of the data subject". That is an
extra hurdle, not a licence.

### 4.2.1 You must have an appropriate policy document

**Schedule 1 Part 2 paragraph 5(1):**

> "Except as otherwise provided, a condition in this Part of this Schedule is met
> only if, when the processing is carried out, the controller has an appropriate
> policy document in place (see paragraph 39 in Part 4 of this Schedule)."

Paragraph 20 contains no exception, so **if you rely on it and you do not have an
APD, the condition is not met and the processing is unlawful.** Most small
intermediaries either have no APD or have one that says nothing about call
recording.

We provide a model you can adapt: `appropriate-policy-document-template.md`. It
is yours to complete — the APD is a **controller** obligation under paragraphs
39–41, and CallGuard as your processor has no APD duty of its own.

〔State the condition relied on, and attach or reference your appropriate policy
document.〕

### 4.3 If you have asked for reduced redaction

⚠ **Decide, and this one has teeth.**

By default CallGuard removes personal data during transcription, so no readable
health information is ever stored. You can ask for named categories to be left
readable — some firms need this to check that what a customer said matches what
was submitted to an insurer.

**If you have asked for health to be left readable, this assessment must say so
here**, and the following all become true:

- Readable health data is stored in your transcripts.
- Only users with the **admin** role can read a transcript. Supervisors and
  viewers get it withheld entirely. 〔Confirm who in your firm holds admin.〕
- Quotes from calls are **withheld** from your CRM, from emails to advisers,
  from downloaded files and from any integration.
- Your Article 9 position and your appropriate policy document have to actually
  cover this.

〔State which categories, if any, you have asked to leave readable, who
authorised it, and the date.〕

---

## 5. Data flow, retention and who sees it

### 5.1 Where the data goes

| Recipient | What they get | Where |
|---|---|---|
| Deepgram | Call audio, for transcription | EU by default 〔confirm with us if you have been placed on the US endpoint〕 |
| Anthropic | Transcript text, for scoring | 〔transfer basis — ask us for the current position〕 |
| Resend | Emails we send on your behalf | 〔as above〕 |
| Amazon Web Services | Stored data | 〔region — ask us〕 |
| 〔Your CRM〕 | Score, verdict, checkpoint names; **not** quotes where 4.3 applies | Your own system |

Neither Deepgram nor Anthropic uses your call content to train their models.
For Deepgram this is enforced on every request by CallGuard's code and cannot be
switched off. For Anthropic it is contractual — **ask us for the current terms
rather than taking this sentence as sufficient.**

### 5.2 Retention

| | Default | Ours |
|---|---|---|
| Visible in the portal | 2 years | 〔 〕 |
| Deleted entirely | 5 years | 〔 〕 |
| After we stop using CallGuard | 30 days | 〔 〕 |

⚠ **Decide.** Five years is a default, not advice. Set it against your own
record-keeping obligations and your own minimisation duty — keeping recordings
longer than you need is not a neutral choice.

### 5.3 Who inside the firm can see what

〔Complete honestly. "Everyone" is an answer, but it is one that changes your
risk rating.〕

| Role | Can see |
|---|---|
| Admin | 〔 〕 |
| Supervisor | 〔 〕 |
| Viewer | 〔 〕 |
| Adviser | Their own calls only — enforced by the platform |

---

## 6. Necessity and proportionality

⚠ **Decide, and write it in your own words.** The question is not whether
monitoring is useful. It is whether monitoring *this much* is necessary for what
you are trying to achieve, and whether you could achieve it less intrusively.

Points you may find relevant:

- Automated scoring is more intrusive per call than sampling, and **less**
  intrusive per finding — nobody listens to a call that turns out to be fine.
- Personal data is removed at transcription by default, so the AI scores a
  transcript with the identifying details already stripped.
- You choose which calls are in scope. 〔Are all calls scored, or only sales?〕

〔Your reasoning here. If you concluded that a narrower scope would do, say what
you narrowed.〕

---

## 7. Telling people

### 7.1 Customers

〔Your privacy notice and call-opening script must cover recording **and** the
automated analysis of the recording. Check the wording applies to **all** calls
you monitor, not just the ones that end in a sale — this is a common gap.〕

- Privacy notice updated: 〔date〕
- Call script wording: 〔quote it〕

### 7.2 Advisers

〔Employees must be told they are monitored, what is monitored, and what happens
to the results. Record how and when. An adviser learning about this from a
feedback email is not adequate notice.〕

---

## 8. Automated decision-making

> If you have seen this section in an older template citing **Article 22**, it is
> out of date. Article 22 was replaced by **Articles 22A–22D**, fully in force
> **5 February 2026**.

**Article 22A(1)(a)** defines the test: a decision is based solely on automated
processing "if there is **no meaningful human involvement** in the taking of the
decision". The question is not whether software was involved — it is whether a
person meaningfully was.

CallGuard's findings are built to be decision support:

- Every finding carries the evidence behind it, so a person can check it.
- Uncertain items go to a human queue rather than being scored automatically.
- Sending feedback to an adviser is a person pressing a button.

⚠ **Decide and record — and this one is not optional if health data is
involved.**

**Article 22B** prohibits a significant decision based entirely or partly on
Article 9 data being taken solely by automated means, except on explicit consent
or a contract/legal route plus Article 9(2)(g). Compliance scoring of protection
calls processes health data. So if a finding drives a consequence for an adviser
with no meaningful human involvement, you are in a **stricter** prohibition than
for ordinary data, not a looser one.

Confirm that **no action affecting an adviser's pay, performance record or
employment follows from a finding without meaningful human review**. CallGuard
supports this and cannot enforce it inside your firm. The safeguard is your
process, and if it is not written down you do not have one.

Note also that "meaningful" is undefined in the Act — Article 22D allows it to
be defined by regulations, and none are yet in force. A supervisor who
rubber-stamps a list is unlikely to satisfy it.

〔Describe your process. Who reviews? What can an adviser do if they disagree?
Article 22C(2), which applies where a decision *is* solely automated, is a useful
model even where it does not bite: information about the decision, the ability
to make representations, to obtain human intervention, and to contest it.〕

---

## 9. Risks

Rate each for your own firm. The mitigations column states what is already true
of the platform; the risk is what remains **after** that.

| # | Risk | Likelihood | Impact | Already mitigated by | Residual |
|---|---|---|---|---|---|
| 1 | Health data exposed to staff who should not see it | 〔 〕 | 〔 〕 | Redaction by default; admin-only transcripts where redaction is reduced; advisers see only their own calls | 〔 〕 |
| 2 | Recording content leaves via CRM, email or an integration | 〔 〕 | 〔 〕 | Quotes withheld from every export where you keep a category readable | 〔 〕 |
| 3 | An adviser is treated unfairly on a wrong finding | 〔 〕 | 〔 〕 | Evidence shown with every finding; human review of uncertain items; overrides recorded | 〔 〕 |
| 4 | Data kept longer than needed | 〔 〕 | 〔 〕 | Automatic deletion on your retention setting | 〔 〕 |
| 5 | A supplier retains or trains on call content | 〔 〕 | 〔 〕 | Training opt-out enforced in code for transcription; contractual for scoring | 〔 〕 |
| 6 | Data transferred outside the UK unlawfully | 〔 〕 | 〔 〕 | Audio processed in the EU by default | 〔 〕 |
| 7 | Customers or advisers not properly informed | 〔 〕 | 〔 〕 | Nothing — this one is entirely yours | 〔 〕 |
| 8 | 〔Your own〕 | | | | |

〔Add any risk specific to your firm. A DPIA with only the supplier's risks in it
is a supplier's document, not yours.〕

---

## 10. Actions before this is signed

| # | Action | Owner | Due |
|---|---|---|---|
| 1 | Confirm the Article 6 basis, and complete a legitimate interests assessment if relying on it | 〔 〕 | 〔 〕 |
| 2 | Confirm the Article 9 condition and put an appropriate policy document in place | 〔 〕 | 〔 〕 |
| 3 | Check the privacy notice and call script cover **all** monitored calls | 〔 〕 | 〔 〕 |
| 4 | Tell advisers, and record that you did | 〔 〕 | 〔 〕 |
| 5 | Write down the human-review process for findings (section 8) | 〔 〕 | 〔 〕 |
| 6 | Set retention deliberately rather than accepting the default | 〔 〕 | 〔 〕 |
| 7 | Ask CallGuard for the current sub-processor, transfer and training positions | 〔 〕 | 〔 〕 |
| 8 | Decide whether any reduced-redaction request is justified, and record who authorised it | 〔 〕 | 〔 〕 |

---

## 11. Outcome

〔Record the decision. If any residual risk is **high** after mitigation, you
must consult the ICO before starting. Say so here if that applies.〕

| | |
|---|---|
| Residual risk accepted by | 〔Name, role〕 |
| Date | 〔 〕 |
| ICO consultation required? | 〔Yes / No — and why〕 |
| Next review | 〔 〕 |

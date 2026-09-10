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
You need a condition under Article 9(2), and for most insurance intermediaries
the relevant route runs through the Data Protection Act 2018's substantial
public interest conditions — the insurance condition in particular.

**If you rely on a Schedule 1 Part 2 condition you must also have an
appropriate policy document in place.** Most small intermediaries either do not
have one, or have one that says nothing about call recording. We provide a model
you can adapt: `appropriate-policy-document-template.md`.

〔State the condition relied on, and attach or reference your appropriate policy
document.〕

*The precise statutory wording and its requirements are being confirmed from
primary sources and will be cited here. Do not rely on this section until that
citation is present — check it against the legislation or take advice.*

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

CallGuard's findings are **decision support**, not automated decisions:

- Every finding carries the evidence behind it, so a person can check it.
- Uncertain items go to a human queue rather than being scored automatically.
- Sending feedback to an adviser is a person pressing a button.

⚠ **Decide and record:** confirm that **no action affecting an adviser's pay,
performance record or employment follows from a finding without a human
reviewing it first.** CallGuard supports this but cannot enforce it inside your
firm — the safeguard is your process, and if you do not have one written down,
you do not have one.

〔Describe your process. Who reviews? What can an adviser do if they disagree?〕

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

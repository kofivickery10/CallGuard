# Verified regulatory citations

Data protection citations used in CallGuard's own documents and in the templates
we give customers. **Verified from primary text on legislation.gov.uk** on the
date shown.

**The rule for this file: nothing goes in it that was written from memory.** If
a claim is not verified, it belongs in the "not verified" section at the bottom,
where a reader can see the gap rather than assume it away.

This file covers **data protection only**. FCA Handbook citations are a separate
matter and are not recorded here.

Last verified: **10 September 2026**.

---

## The four things that were wrong before verification

Recorded because they are the errors most likely to recur, and because two of
them are recent changes that older documents and older training data will still
get wrong.

| Was going to say | Actually |
|---|---|
| Article 22 (automated decision-making) | **Omitted.** Replaced by Articles 22A–22D, fully in force 5 Feb 2026 |
| Article 45 (adequacy) | **Omitted.** Replaced by Articles 45A/45B, 5 Feb 2026 |
| APD requirement at "Sch 1 Part 4 para 5" | **Part 2 para 5** imposes it; Part 4 paras 38–41 govern it. There is no para 5 in Part 4 |
| Insurance condition covers criminal offence data | It does **not**. Para 20(1)(b) lists Article 9 categories only — use Part 3 para 37 |

---

## UK GDPR

### Article 5 — principles
Referenced by DPA 2018 Sch 1 para 39(a). Standard six principles plus
accountability at 5(2).

### Article 22 — **OMITTED**
Omitted by the Data (Use and Access) Act 2025 s.80(1). **Do not cite Article
22(1).**

### Articles 22A–22D — automated decision-making
Inserted by DUAA 2025 s.80(1), Sch.; in force 19 June 2025 for specified
purposes, **5 February 2026** otherwise (S.I. 2026/82 reg. 2(j)).

**22A(1)** — the definitions that matter:
> "(a) a decision is based solely on automated processing if there is no
> meaningful human involvement in the taking of the decision, and (b) a decision
> is a significant decision, in relation to a data subject, if— (i) it produces
> a legal effect for the data subject, or (ii) it has a similarly significant
> effect for the data subject."

**22A(2)** — profiling is a factor in judging meaningful involvement.

**22B(1)** — the special category prohibition. A significant decision based
entirely or partly on Article 9(1) processing "may not be taken based solely on
automated processing" unless explicit consent, or contract/legal authorisation
plus Article 9(2)(g).

**22C(2)** — safeguards where a decision *is* solely automated: information
about the decision; the ability to make representations; to obtain human
intervention; to contest.

**22D(1)** — the Secretary of State may define "meaningful human involvement" by
regulations. **None in force as at 10 Sep 2026**, so the term is undefined.

*Why this helps us:* the human-review argument used to be an ICO-guidance gloss.
It is now the statutory test at 22A(1)(a).
*Why it also constrains us:* 22B is stricter than old Article 22 for health
data, which is what we process.

- https://www.legislation.gov.uk/eur/2016/679/article/22A
- https://www.legislation.gov.uk/eur/2016/679/article/22B
- https://www.legislation.gov.uk/eur/2016/679/article/22C
- https://www.legislation.gov.uk/eur/2016/679/article/22D

### Article 28(3)(f) — processor's duty to assist
> "assists the controller in ensuring compliance with the obligations pursuant
> to Articles 32 to 36 taking into account the nature of processing and the
> information available to the processor"

Note the **range** is Articles 32–36 (security, breach notification, DPIAs,
prior consultation) — not a standalone DPIA duty. The two qualifiers are our
scope limit and should be reproduced in the DPA rather than dropped.

https://www.legislation.gov.uk/eur/2016/679/article/28

### Article 35 — DPIAs
No DUAA amendment; last amended by S.I. 2019/419 (31 Dec 2020).

**35(1)**:
> "Where a type of processing in particular using new technologies, and taking
> into account the nature, scope, context and purposes of the processing, is
> likely to result in a high risk to the rights and freedoms of natural persons,
> the controller shall, prior to the processing, carry out an assessment..."

**35(3)** — mandatory cases:
> (a) "a systematic and extensive evaluation of personal aspects relating to
> natural persons which is based on automated processing, including profiling,
> and on which decisions are based that produce legal effects concerning the
> natural person or similarly significantly affect the natural person";
> (b) "processing on a large scale of special categories of data referred to in
> Article 9(1), or of personal data relating to criminal convictions and
> offences referred to in Article 10";
> (c) "systematic monitoring of a publicly accessible area on a large scale".

⚠ **35(3)(c) is about a publicly accessible area, not employees at work.** Our
hooks are **(a)** and **(b)**. Employee monitoring is a 35(1) high-risk
argument, not a 35(3) case.

https://www.legislation.gov.uk/eur/2016/679/article/35

### Article 45 — **OMITTED**
> "Art. 45 omitted (5.2.2026) by virtue of Data (Use and Access) Act 2025
> (c. 18), s. 142(1), Sch. 7 para. 3; S.I. 2026/82, reg. 2(z9)."

https://www.legislation.gov.uk/eur/2016/679/article/45

### Articles 45A / 45B — adequacy, replacing 45
Inserted by DUAA 2025 Sch. 7 para. 4.

**45B(1)** — the **"data protection test"**:
> "...the data protection test is met in relation to transfers of personal data
> to a third country or international organisation if the standard of the
> protection provided for data subjects with regard to general processing of
> personal data in the country or by the organisation is **not materially lower**
> than the standard of the protection provided for data subjects by or under—
> (a) this Regulation, (b) Part 2 of the 2018 Act, and (c) Parts 5 to 7 of that
> Act, so far as relevant to general processing."

⚠ **"Not materially lower"**, not the EU's "essentially equivalent". A real
divergence; do not describe them as the same test.

- https://www.legislation.gov.uk/eur/2016/679/article/45A
- https://www.legislation.gov.uk/eur/2016/679/article/45B

### Article 46 — appropriate safeguards
46(2) preserves: binding corporate rules (Art 47); standard clauses in
regulations under Art 47A(1); and **"standard data protection clauses specified
in a document issued by the Commissioner under section 119A of the 2018 Act"** —
which is the limb carrying the **IDTA and the UK Addendum**. Both survive.

*Not fully verified:* the exact wording of the new 46(1A) and 46(6)–(8), which
apply the "not materially lower" test to the exporter's own assessment. Verify
before quoting.

https://www.legislation.gov.uk/eur/2016/679/article/46

---

## Data Protection Act 2018

### s.10(3) — the gateway to Article 9(2)(g)
> "The processing meets the requirement in point (g) of Article 9(2)... only if
> it meets a condition in Part 2 of Schedule 1."

**s.10(5)** — Article 10 (criminal offence) data needs a condition in Part 1, 2
**or 3**.

https://www.legislation.gov.uk/ukpga/2018/12/section/10

### Sch 1 Part 2 para 5(1) — the APD requirement
> "Except as otherwise provided, a condition in this Part of this Schedule is met
> only if, when the processing is carried out, the controller has an appropriate
> policy document in place (see paragraph 39 in Part 4 of this Schedule)."

Paragraph 20 contains no disapplication, so the APD is required for it.
*Caveat: the absence of a carve-out was verified in para 20 itself; not every
other Part 2 paragraph was audited for "otherwise provided" instances.*

https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/5

### Sch 1 Part 2 para 20 — Insurance
In force 25 May 2018; no amendments to the paragraph.

**20(1)**:
> "This condition is met if the processing— (a) is necessary for an insurance
> purpose, (b) is of personal data revealing racial or ethnic origin, religious
> or philosophical beliefs or trade union membership, genetic data or data
> concerning health, and (c) is necessary for reasons of substantial public
> interest, subject to sub-paragraphs (2) and (3)."

**20(5)** — "insurance contract" means a contract of general or long-term
insurance. "Insurance purpose" is a **closed list**: "(a) advising on,
arranging, underwriting or administering an insurance contract, (b)
administering a claim under an insurance contract, or (c) exercising a right, or
complying with an obligation, arising in connection with an insurance
contract...". **20(7)** ties the terms to the FSMA 2000 s.22 regulated
activities order.

Three points that are routinely got wrong:

1. **Not limited by product line**, but limited by the FSMA definition. **Mortgage
   advice is not an insurance purpose** — a firm doing both needs a separate
   analysis for the mortgage side.
2. **Does not reach criminal offence data.** Limb (b) is Article 9 categories
   only. Use Part 3 para 37.
3. **No general "consent not required" dispensation.** Sub-paras (2)–(4) apply
   only where the processing is not for measures/decisions about the data
   subject *and* the subject has no rights or obligations under the contract.
   There, 20(3) *adds* a requirement that the processing "can reasonably be
   carried out without the consent of the data subject", confined by 20(4) to
   where the controller "cannot reasonably be expected to obtain the consent"
   and "is not aware of the data subject withholding consent". **20(6)**: failing
   to respond to a consent request is not withholding. An extra hurdle, not a
   licence.

https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/20

### Sch 1 Part 3 para 37 — Extension of insurance conditions
Met where processing "would meet the condition in paragraph 20... but for the
requirement for the processing to be processing of a category of personal data
specified in paragraph 20(1)(b)". This is the criminal-offence-data route.

https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/37

### Sch 1 Part 4 — the appropriate policy document
**There is no paragraph 5 in Part 4.** Part 4 is paragraphs 38–41.

**Para 38** — scope: applies where a condition in Part 1, 2 or 3 requires an APD.

**Para 39** — contents. **Two limbs, and that is the whole list:**
> "...if the controller has produced a document which— (a) explains the
> controller's procedures for securing compliance with the principles in Article
> 5 of the UK GDPR ... in connection with the processing of personal data in
> reliance on the condition in question, and (b) explains the controller's
> policies as regards the retention and erasure of personal data processed in
> reliance on the condition, giving an indication of how long such personal data
> is likely to be retained."

**Para 40** — retention, review, availability:
> "(1) ...the controller must during the relevant period— (a) retain the
> appropriate policy document, (b) review and (if appropriate) update it from
> time to time, and (c) make it available to the Commissioner, on request,
> without charge. (2) 'Relevant period'... means a period which— (a) begins when
> the controller starts to carry out processing... and (b) ends at the end of the
> period of 6 months beginning when the controller ceases to carry out such
> processing."

**Para 41** — supplements the Article 30 record: which condition is relied on;
how the processing satisfies Article 6; and whether data is retained and erased
in accordance with the para 39(b) policies, "and, if it is not, the reasons for
not following those policies".
*High confidence but returned partly paraphrased — verify word-for-word before
quoting.*

⚠ **Paras 39, 40 and 41 all say "the controller".** CallGuard as processor has
no APD obligation under Schedule 1. Our model APD is a customer deliverable;
never imply we "maintain an APD" as a processor-side control.

- https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/38
- https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/39
- https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/40
- https://www.legislation.gov.uk/ukpga/2018/12/schedule/1/paragraph/41

---

## The UK–US Data Bridge

**Still in force.** The chain, traced:

1. The Data Protection (Adequacy) (United States of America) Regulations 2023
   (S.I. 2023/1028), in force 12 October 2023, made under **DPA 2018 s.17A**.
2. **DUAA 2025 Sch. 9 para. 26**: regulations made under s.17A "are to be
   treated, on and after that day, as if made under Article 45A".
3. So the omission of Article 45 did not take the data bridge with it.

*The savings are in **Schedule 9**, not Schedule 7. Anyone citing Sch. 7 for this
is wrong.*

### What a UK exporter must check about a US recipient

Adequacy is **not country-wide**. Reg. 3 specifies the US as adequate only for
transfers to persons on the Data Privacy Framework List **participating in the
UK Extension**, where the data will be subject to the applicable principles on
receipt. So per recipient:

1. the certification is **active**;
2. it **expressly includes the UK Extension** — a US firm can be DPF-certified
   for the EU only, and this is the most common error;
3. it covers the relevant data categories.

Re-check at each annual recertification.

- https://www.legislation.gov.uk/uksi/2023/1028/made
- https://www.legislation.gov.uk/ukpga/2025/18/schedule/9

---

## Commencement and consequential instruments

- **S.I. 2026/82** — DUAA 2025 Commencement No. 6. Carries the 5 Feb 2026 dates
  for Articles 22A–22D (reg. 2(j)) and the Article 45 omission (reg. 2(z9)).
- **S.I. 2026/386** — Consequential Amendments and Transitional Provision
  Regulations 2026. Largely renames **"Information Commissioner" to "Information
  Commission"**. ⚠ If this commences before we publish, references to "the
  Commissioner" in Sch 1 para 40(1)(c) and Article 46(2)(d) need updating.

---

## NOT verified — do not quote

**Everything ICO.** ICO's site returns HTTP 403 to automated retrieval and the
Wayback Machine was unavailable, so **nothing sourced to ICO below is
verbatim-verified.** Read it against the source before quoting any of it to a
customer.

| Claim | Status |
|---|---|
| ICO's high-risk list includes "innovative technology" and "biometric or genetic data", each requiring a DPIA "in combination with any of the criteria from the European guidelines" | Search-snippet level only |
| ICO: "in most cases, a combination of two of these factors indicates the need for a DPIA. However, this is not a strict rule" | Search-snippet level only |
| Whether "systematic monitoring of employees at work" appears as a **discrete entry** on ICO's high-risk list | **Could not confirm.** Do not assert it |
| ICO monitoring-workers guidance: workers are potentially **vulnerable data subjects** because of the employer/worker power imbalance; employers "should consult with their workers first, and involve them in producing a DPIA"; tools using analytics to make inferences about workers trigger a DPIA | Search-snippet level only |
| ICO guidance on automated decision-making | **Draft.** Consultation closed 29 May 2026, final due Winter 2026. Do not cite as settled |
| Article 46(1A) and 46(6)–(8) exact wording | Returned paraphrased; verify before quoting |
| Sch 1 para 41 exact wording | High confidence, partly paraphrased; verify before quoting |
| Whether every Part 2 paragraph other than 20 has an APD carve-out | Not audited |

---

## Product claims that are not legal citations

These are claims about CallGuard rather than about the law, and they belong to
whoever can evidence them. Recorded here because our data protection documents
depend on them.

| Claim | Status |
|---|---|
| Anthropic does not train on commercial API inputs | **Contractual, unverified.** Quote the current terms before telling a customer |
| Deepgram EU endpoint keeps data in the EU end to end, not only at ingress | **Unverified.** Worth asking them directly |
| The AWS region holding the database | **Unverified.** go-live.md names the provider, not the region |
| Deepgram / Anthropic DPF UK Extension certification | **Unchecked.** See the data bridge section above |

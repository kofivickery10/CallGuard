# Trust Point — the 10 question sets awaiting confirmation

25 August 2026. Every pending format was re-fetched from the CRM, re-parsed with
its own stored `parse_config`, and compared against the document it was learned
from (`packages/api/src/scripts/review-pending-profiles.ts`, read-only).

**Nothing here should be confirmed.** All ten either describe a document that is
not the application, or describe the application so thinly that confirming them
would make the tenant's checking *worse* than it is today.

## Why "worse", specifically

`activateProfile` re-queues **every** completed model-read run in the tenant, and
`resolveApplicationDocument` stops at the first document whose *content* matches
an active format. So a thin format going live does not just affect the sale it
came from — it becomes the tenant-wide answer for any pack containing a document
like it, and it displaces the model fallback that is currently reading those
packs in full.

Measured on the source sales themselves (items produced by the current model
read vs. items the proposed format would produce):

| Sale | model read today | proposed format |
|---|---|---|
| Aviva | 72 | 8 (5 of them page footers) |
| Legal & General (full application) | 40 | 4 |
| Legal & General (quote) | 66 | 3 |
| Scottish Widows | 45 | 22, none of them disclosures |
| National Friendly | 19 | 6 |

## The ten

| # | Insurer / product | Learned from | Q | Verdict |
|---|---|---|---|---|
| 1 | Aviva / Life Insurance+ | the application | 8 | dismiss — failed parse |
| 2 | Experian / Due Diligence Verification | the identity-search sheet | 10 | dismiss — not an application |
| 3 | Legal & General / Life Insurance - Personal Quote | the quote | 3 | dismiss — not an application |
| 4 | Legal & General Assurance Society Limited / Life Insurance | the application | 4 | dismiss — parser cannot read this layout |
| 5 | MetLife / EverydayProtect (v2) | the application | 17 | dismiss — duplicate of the live v1 |
| 6 | National Friendly / Simple cover | the quote | 6 | dismiss — not an application |
| 7 | National Friendly / Simple cover options | the same quote | 6 | dismiss — duplicate of #6 |
| 8 | Royal London / Menu Plan Life Cover | a UnderwriteMe quote summary | 7 | dismiss — not an application |
| 9 | Scottish Widows / Scottish Widows Protect | the application | 22 | dismiss — captures no disclosures |
| 10 | Vitality / Life Cover | a UnderwriteMe quote summary | 6 | dismiss — not an application |

### 1. Aviva / Life Insurance+
Right document, failed parse. Five of the eight "questions" are the page footer
(`Page \t2 \tof \t6`); the real health and lifestyle questions are swallowed into
the `guidance` blob underneath them. The stored `parse_config` also carries a
`labels` array — a `label_value` config — while `strategy` is `question_answer`,
so the labels are never used.

This is the exact case `proposalIsUsable` was written for (5/8 = 0.63, over the
1/3 refusal share). The row predates that gate: it was proposed 12 Aug.

### 2. Experian / Due Diligence Verification
Learned from the sanctions / identity-search PDF, which is filed on every sale
and ranked at **−5** precisely so it is never mistaken for the application. It
parses cleanly (10/10 fields, fingerprint matches) — but the fields are `SSID`,
`Authentication Index`, `Royal Mail PAF Confirmation`, `CRA`. Nothing a customer
disclosed. Its sale's pack contains no application at all.

### 3. Legal & General / Life Insurance - Personal Quote
Learned from the quote PDF, not from the application sitting next to it in the
same pack. Three fields, two of which run on past their value ("29 years Your
monthly premium is £41.96. Please remember…") because `valueTerminators` is
incomplete.

### 4. Legal & General Assurance Society Limited / Life Insurance
The **right** document — the full 19-page *Protection Application Details*, with
smoking, alcohol, drug, occupation and the whole "Have you ever…" health block.
The config lists 68 labels. Four parse.

Cause: `parseLabelValue` requires `Label:` — a literal colon. This document
prints `• Label` on one line and the value on the next, with no colon anywhere
except the height and weight lines. So the only four questions captured are
Height Metric, Height Imperial, Weight Metric, Weight Imperial.

### 5. MetLife / EverydayProtect (v2)
`questions` is byte-identical to the **active** v1 (`87370261…`); only the
detect patterns and parse config differ. There is no change to approve, and
confirming it would supersede the working v1 and re-queue the tenant.

### 6 & 7. National Friendly / Simple cover *and* Simple cover options
Two proposals, one journey, one document (the quote), identical fingerprints,
identical six questions. The application on that same sale is what the model
read for its 19 items.

### 8. Royal London / Menu Plan Life Cover
An UnderwriteMe **quote summary**, not an application — `Quote Summary`,
`Ref: UME`, seven admin fields. `Quote Reference Number`'s answer swallows the
name, DOB, smoker status and occupation that follow it, and question 4 is the
fragment `"For"`. Its sale's pack has seven attachments and no application.

### 9. Scottish Widows / Scottish Widows Protect
The right document, and the config *does* list the underwriting questions —
"What is your job?", "How tall are you?", the five "Have you ever had:" blocks,
the "In the last 5 years have you had any of these:" blocks. None of them parse,
for the same reason as #4: the `UNDERWRITING DISCLOSURES` section prints no
colons. What survives is 22 policy and contact fields, five of which are
marketing-consent flags that parse to null.

### 10. Vitality / Life Cover
Same shape as #8 — an UnderwriteMe quote summary, six fields, question 3 is the
fragment `"For"`. The sale's pack contains no application.

## Root causes worth fixing

**A. `label_value` cannot read a bullet-label document.** The colon is mandatory
in `parseLabelValue`. Two of the three insurers whose *real* application is
already in the pack (L&G, Scottish Widows) print `• Label` / value-on-next-line,
and Aviva prints a two-column `Questions | Your answers` table with a single
delimiter per section. Until one of these layouts is supported, those three
insurers can only ever be read by the model fallback.

**B. Nothing stops a format being learned from a document that is not an
application.** `hasDisclosureQuestions` exists and is computed, but it only
*ranks* candidates (`candidateScore`) — it never gates the insert. Meanwhile
`reconcileByModel`'s extraction guard **refused every one of those same
documents** ("not an application"), which is why sales 2, 8 and 10 sit at
`needs_profile` with no model read. Two halves of one pipeline disagreeing, and
the disagreement is handed to a person as something to approve.

**C. `check_mode` is missing from five of the ten** (Aviva, MetLife, both
National Friendly, Scottish Widows) — and from **all five active formats**.
`DocumentProfileReview` renders `q.check_mode ?? 'reconcile'`, so the screen says
"Check against the call"; `reconcile.ts` uses `ruling?.checkMode ??
defaultCheckMode(pair.question)`, so the heuristic decides. The reviewer is not
approving what will be applied. A backfill stamping `defaultCheckMode(question)`
onto every question that lacks one changes no behaviour and makes the screen
truthful.

**D. `valueTerminators` are routinely too short**, so answers run on into the
next paragraph (#3, #8, and Height Imperial / Weight Imperial in #4).

## What was changed

### In the code — so the queue stops refilling with these

**`countLabelRows` / `expectedRecordCount`** (`services/application-pdf.ts`).
Coverage used to claim nothing at all for `label_value`, on the reasoning that
"a label absent from the sheet is absent, not lost". True of a conditional
question the customer was never asked; false of one the document prints at the
head of its own line. It now counts label *rows* — a line whose start is the
label, optionally after a bullet, terminated by a colon, a tab or the end of the
line — which is exactly the shape `parseLabelValue` is supposed to read. So
"present as a row but never parsed" becomes a measurable loss, and a genuinely
absent label stays absent.

Measured on the ten (parsed ÷ label rows the document prints):

| Format | ratio | now |
|---|---|---|
| L&G Assurance Society / Life Insurance | 4/41 = 0.10 | refused |
| Experian / Due Diligence | 10/25 = 0.40 | refused |
| National Friendly / Simple cover (×2) | 6/12 = 0.50 | refused |
| Scottish Widows / Protect | 22/43 = 0.51 | refused |
| Vitality / Life Cover | 6/7 = 0.86 | warned |
| MetLife / EverydayProtect (live) | 17/13 = 1.31 | unaffected |
| Royal London / Menu Plan Life Cover | 7/7 = 1.00 | unaffected |

The refusal names the questions that were not read, because "22 of 43" says the
parse is broken while "not read: *What is your job?*, *How tall are you?*, *Have
you ever had:* …" says what stops being checked.

**Duplicate collapse** (`learnProfileFromSale`). The existing lookup is keyed on
the format signature, which is derived from the detect patterns — so one document
read twice by a model that worded its patterns differently yields two signatures
and two proposals. It now also reuses a profile carrying the same question
fingerprint, *guarded on that profile actually matching this document*, which is
what keeps the reuse safe: an identical question set alone would let a profile
whose patterns never fire absorb a document it can never read. Covers MetLife v2
and the National Friendly pair.

**`withdrawProposal`** (`services/reconciliation-runs.ts`, called from
`processors/reconcile.ts`). Learning a format and reading a document are two
judgements and only the second asks "is this an application at all":
`extractApplicationPairs` refuses a non-application word-for-word against the
text, while the learner's `hasDisclosureQuestions` only *ranks* candidates. So a
pack with no application produces both a proposal and a model read that refuses
the very document it was learned from. `reconcileByModel` tries the learner's
chosen document first, so when it returns nothing the proposal has been
disproved — and it is now taken back, recorded as a dismissal so the next sweep
tick does not propose it again. Covers Experian, Royal London and Vitality, one
of which had been re-proposed sixty times.

Together the three gates account for all ten: parse quality catches five (Aviva
via the existing corruption gate at 5/8, plus the four label-coverage failures),
duplicate collapse catches three, and the withdrawal catches the rest.

### In the tenant — scripts, dry-run by default

- **`retire-unconfirmable-formats.ts`** — dismisses the ten with the reason on
  each, matched on insurer + product + fingerprint before it writes, so a stale
  id or a re-proposed format is reported and skipped rather than dismissed by
  accident. Reversible: `activateProfile` accepts a dismissed row.
- **`backfill-question-check-modes.ts`** — stamps `defaultCheckMode(question)`
  onto the 214 questions that carry none. No behaviour change; it writes what
  reconcile already applies. What changes is that the screen stops claiming
  "Check against the call" over five questions the pipeline treats as `none` or
  `presence` — `Policy number` and `Date of application` on MetLife, `Plan
  number` on Royal London, `Account Number` and `Account Sort Code` on Shepherds
  Friendly.
- **`review-pending-profiles.ts`**, **`dump-sale-documents.ts`**,
  **`try-parse-config.ts`** — the read-only bench this review was done with.

### Still open

Two sales have no application in the pack at all (the Experian and Royal London
ones) and say so as `needs_profile` — "none of the attached documents match a
known format", which sends the firm hunting for a format when the truth is the
application was never uploaded. Worth a separate status.


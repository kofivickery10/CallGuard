# Remediation guidance per finding

**Status:** scope and estimate, not approved
**Date:** 7 September 2026
**Task:** CG-6 (Dev) — raised by Trust Point, Joey Crone, 26 August 2026
**Scope:** attaching firm-authored remediation guidance to a scorecard criterion,
putting it in front of the adviser, and capturing what they did about it.

---

## 1. The one-paragraph version

Trust Point asked for something small-sounding: a line of guidance next to a
finding telling the adviser what to do about it. What it actually adds is the
sixth and final step of the evidence chain — **remediated** — the one that
answers *"what did you do about it?"* rather than only *"were you told?"*. The
build is unusually cheap because the five steps before it already exist: the
feedback record, the per-finding snapshot, the tokenised adviser link and the
one-click acknowledgement all shipped in migration 087. Guidance text is a fifth
field of a kind `scorecard_items` already has four of. The genuinely new work is
the adviser-facing outcome capture, which is constrained by the fact that
advisers may have no login at all and can only be reached through the existing
tokenised page. **Estimated 5–7 dev-weeks** for the full workflow across four
independently shippable phases, of which **Phase 1 is roughly one week and on its
own answers Joey's example.**

---

## 2. What Joey actually asked for

> "How difficult would it be to add in some manual/remediation guidance for some
> of the feedback lines? For example, if we've not told someone we will send docs
> by email, I'd want the adviser to ring the client back and let them know that's
> how they get their documents and to let us know if that's not OK."

Read closely, there are three separate asks in there:

1. **Guidance attached to a finding** — "ring the client back and let them know".
2. **A specific, firm-authored instruction** — not our generic advice. He knows
   what he wants the adviser to say, and it is particular to his firm.
3. **A loop that closes** — "let us know if that's not OK" implies the adviser
   reports back, and someone at Trust Point reads it.

The third is the expensive one and the valuable one. Guidance text alone is a
week; the closed loop is the product.

### The one worked example, and what is still outstanding

This design is built around Joey's single example: a missing "we'll send your
documents by email" disclosure, remediated by the adviser calling the customer
back. CG-6 records an action to **ask Joey for the handful of further examples he
has in mind**, and that ask is still open.

That is a real gap, but not a blocking one, and deliberately so: because guidance
is authored per criterion by the firm in their own words, additional examples
arrive as **data, not as design changes**. If his other examples turn out to need
something structurally different — a document to re-send, a form to re-collect, a
third party to notify — that would change the design, and it is the main risk
this scope carries. Getting those examples before Phase 2 starts would retire it.

---

## 3. What already exists

This section is the reason the estimate is as low as it is. Each claim below is
traceable to a file, so the estimate can be argued with on evidence.

**The acknowledgement half is already built.**
`packages/api/src/db/migrations/087_journey_feedback.sql` and
`packages/api/src/services/journey-feedback.ts` give us, today: a per-sale
feedback record, a snapshot of exactly what the adviser was told, a SHA-256
hashed single-use time-bound token, an unauthenticated confirm page, and
`feedback_sent` / `feedback_confirmed` rows written onto each breach's own
history. Remediation is the next link on a chain that is already four links long,
not a new subsystem.

**`journey_feedback_items` is the right place to hang an outcome.** It is already
keyed `(feedback_id, scorecard_item_id)` and deliberately *copies* `item_label`
and `severity` rather than joining them, so that a re-score cannot retroactively
rewrite what someone was told. Migration 087's header spells out why: breaches
are dropped and recreated on every scoring run, so `breaches.id` is not a durable
identity for a finding and an outcome keyed to it would not survive. The
remediation outcome inherits that durability for free by living on this row.

**Guidance text is a fifth field of a kind we already have four of.**
`scorecard_items` already carries firm-authored per-checkpoint prose —
`description`, `expectation`, `ai_check`, plus the `section` grouping — added by
`040_scorecard_checkpoint_model.sql` and typed in
`packages/shared/src/types/scorecard.ts`. The scorecard editor
(`packages/web/src/pages/ScorecardEditor.tsx`) already renders those fields and
already parses them as CSV import columns. A `remediation_guidance` column
follows an established path end to end.

**The adviser channel exists, and it is the only one.** `ORG_WIDE_ROLES` in
`packages/shared/src/types/user.ts` excludes `adviser`; advisers are self-scoped
everywhere, and many have no login at all. The one surface that reliably reaches
an adviser is the tokenised, unauthenticated `/feedback/:token` page
(`packages/web/src/pages/FeedbackConfirm.tsx`). This is the single biggest
constraint on the design and is dealt with in §4.3.

**The report surfaces already have the join shapes.** The claims-defence pack
(`packages/api/src/routes/journeys.ts`, `GET /:id/claims-defence`) and the board
pack (`packages/api/src/routes/board-pack.ts`) both already select findings per
scorecard item, so a remediation outcome joins in without any new attribution
logic. `packages/api/src/services/audit.ts` already carries
`journey.feedback_sent` and `journey.feedback_confirmed` action types to extend.
And `routes/breaches.ts` already ages open findings with
`EXTRACT(EPOCH FROM (now() - b.detected_at)) / 86400`, which is exactly the
arithmetic the "aged open remediations" report needs.

**What does not exist:** any concept of an outcome, any adviser-facing write
other than the single confirm click, and any surface where an adviser sees *what
a finding was about*. That last one matters — see §4.3.

---

## 4. The design

### 4.1 Guidance authored per criterion, by the firm

A new nullable `remediation_guidance TEXT` on `scorecard_items`, authored by the
firm in their own words — exactly like `expectation` and `ai_check`, and for the
same reason: Trust Point know what they want said to their customers and we do
not.

Null is the normal case and the natural gate. **A criterion with no guidance
simply has no remediation step**, so firms opt in per checkpoint rather than
being handed a workflow on all eighty. Joey's example becomes guidance text on
one criterion; nothing else changes.

Touches: one migration, the `ScorecardItem` / `ScorecardItemInput` types, the
three insert/update sites in `routes/scorecards.ts`, one editor field, and one
CSV import column.

### 4.2 Surfaced in the email, and in the platform before it is sent

`jobs/processors/feedback-email.ts` today renders each finding as label plus a
severity chip. It gains the guidance line underneath the label, for the findings
that have one. `services/journey-feedback.ts` already assembles the items payload
in `breachesForFeedback` — it carries one more column.

The same guidance appears in the platform, on the feedback panel a supervisor
already reviews before sending (`packages/web/src/components/FeedbackPanel.tsx`,
fed by `GET /journeys/:journeyId/feedback` in `routes/journey-feedback.ts`, which
already returns the findings list the panel renders). That panel exists precisely
so a supervisor sees what they are about to send before they send it — its own
header comment says so — and guidance they cannot see is guidance they cannot
sanity-check against the sale in front of them.

This slice alone satisfies the literal text of Joey's request. It is the reason
Phase 1 is worth shipping on its own.

### 4.3 Outcome capture, and the constraint that shapes it

`done` / `not needed` / `customer unreachable`, plus a free-text note, per
finding. Three decisions make this work:

**It rides on the existing tokenised page.** Anything requiring a login is
unreachable by a large share of the advisers it exists for. The confirm page
already handles the token lifecycle — `lookupFeedback` reads without writing so
that a mail-security gateway's prefetch cannot fabricate anything, and
`confirmFeedback` is idempotent on a re-POST. Outcome capture extends that page
rather than adding a surface.

**Confirmation gates the outcome, which removes an entire class of data loss.**
`sendFeedback` deletes a previous *unconfirmed* feedback when a supervisor
re-sends. If outcomes could be recorded before acknowledgement, a re-send would
silently destroy them. Requiring `confirmed_at` before any outcome can be written
means the delete can never reach one. The ordering is also the right workflow:
see it, acknowledge it, then act on it.

**The link stays usable after confirmation.** It already does — `lookupFeedback`
returns `already_confirmed` rather than failing — so the adviser can come back
over days as they reach the customer. The 30-day `TOKEN_TTL_DAYS` becomes a real
constraint here rather than a formality; see the open questions.

**Storage:** columns on `journey_feedback_items` (`remediation_outcome`,
`remediation_note`, `remediated_at`, `remediated_by`) rather than a new table.
That row is already the durable per-finding identity and already survives
re-scores. History does not need a second table either — `breach_events` is
already the per-finding history and already had its event-type constraint
widened once by migration 087, which is the precedent to follow.

**Privacy.** The confirm page deliberately reveals nothing beyond the adviser's
own name and a count — not the sale, not the customer, not what any finding is
about. Showing findings and guidance widens that materially. The judgement here
is that it is acceptable and necessary: the recipient is the named adviser who
handled the sale, the content is their own conduct rather than the customer's
data, and guidance text is firm-authored and contains no customer information.
The page must still name no customer and link to no sale. This should be a
conscious sign-off, not a silent consequence, and it belongs in the DPIA update.

### 4.4 Into the audit trail and the evidence pack

Two new `breach_events` types (`remediation_recorded`, and
`remediation_accepted` if §6's sign-off question lands that way), two new
`AuditActionType` entries alongside the existing feedback pair, the outcome
fields added to `ClaimsDefenceFinding` in the claims-defence pack, and a
remediation line in the board pack.

The claims-defence pack is where this pays off. It already goes to insurers,
compliance officers and the Ombudsman, and it already carries "what was found"
and "who ruled on it". Adding "and here is what was done about it, when, by whom,
and whether the customer was reached" is the strongest single upgrade available
to that document.

### 4.5 Reporting

Open remediations, aged, by adviser — the aging arithmetic is already in
`routes/breaches.ts` and the adviser attribution join already exists in three
places. Presented as a supervisor-facing view of what has been asked for and not
yet closed.

---

## 5. Phasing and estimate

Each phase is independently shippable and independently useful. Estimates are
dev-weeks including tests, and assume the existing patterns hold.

| Phase | What ships | Estimate |
|---|---|---|
| **1** | Guidance on the criterion; guidance in the feedback email | **1 week** |
| **2** | Outcome capture on the tokenised adviser page | **2–2.5 weeks** |
| **3** | Audit trail, claims-defence pack, board pack | **1 week** |
| **4** | Open-remediations reporting, aged, by adviser | **1–1.5 weeks** |
| | **Total** | **5–7 weeks** |

Phase 2 dominates because the confirm page currently shows the adviser nothing
about the findings themselves — it is a single button. Turning it into a
per-finding list with guidance, an outcome control, a note field and a
post-confirmation return path is close to a rewrite of that page, and it is the
one surface in the product that must work for someone with no account, possibly
on a phone, possibly weeks after the email arrived.

An optional Phase 5 — supervisor sign-off on outcomes, chase reminders for
overdue remediations — is roughly a further week, and §6 argues part of it may
not be optional.

---

## 6. Open questions

**Should a self-attested outcome count as evidence?** As designed, the adviser
records "done" and that is the record. For internal coaching that is fine. For a
document that goes to the Ombudsman it is weaker than it looks, and a supervisor
accept/reject step would close the gap. This is the most consequential open
question in the scope and it is a compliance judgement, not an engineering one.
Recommend asking Joey directly — his "let us know if that's not OK" hints that
somebody at Trust Point expects to read these.

**Is 30 days long enough?** "Customer unreachable" is a conclusion an adviser
reaches after repeated attempts over weeks. If the link expires mid-chase there
is no way back to it without a re-send. Options: extend the TTL for feedback
carrying remediations, or let a supervisor re-issue a link without creating a new
feedback record.

**Can a supervisor override the guidance for one sale?** The design has guidance
fixed per criterion. A supervisor may want to say something specific about one
sale — the existing free-text `message` field on the feedback already covers that
at the sale level, but not per finding. Cheap to add later; not in the estimate.

**Should an open remediation block anything?** Re-scoring, closing a breach,
feeding back again. The safe default is no — remediation is recorded alongside
the workflow, not in front of it — but it should be a decision rather than an
omission.

**Joey's remaining examples.** Outstanding, and the main risk to Phase 2's
estimate. See §2.

---

## 7. Commercial note

CG-6 records that this is a materially bigger product than what Trust Point
currently pay for, and that it belongs in the founding-rate conversation and the
pricing model rather than in a reply to the original email. The account plan
argues it should occupy the upsell tier that live scoring cannot fill, because it
works on recordings — no dialler integration required — and because a customer
asked for it unprompted, which is the strongest demand signal available.

Recorded here for completeness. Not a decision this document makes.

---

## 8. Provenance note

The FCA outcomes-monitoring point in CG-6 — that a review of 56 firms found firms
collecting relevant management information but unable to show how it drove
decisions or improved outcomes — is repeated here as context because it is the
sharpest available argument for why a closed loop beats a dashboard. It has
**not** been verified against primary source in this pass. It must go through the
`regulatory-researcher` agent before it appears in any customer-facing copy,
pitch deck or landing page.

No CallGuard reconciliation or false-positive figures appear in this document.
The published figures are stale pending the production re-run.

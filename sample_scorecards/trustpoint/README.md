# Trust Point — Protection QA onboarding

Scorecard + KB mapping for Trust Point, originally built from their supplied
files (QA Framework and Scoring Matrix June 2026.xlsx, the two Protection Wrap-Up
scripts, and Sales Process v4 — all under `docs/trustpoint/`). Status: **v2.1 —
mirrors the card Trust Point actually run (production scorecard v9), less the
five checkpoints they retired on 2026-08-03 after reviewing live scoring.**

## Scorecards

**Use `trustpoint-protection.csv`** — a single branched scorecard covering both
application outcomes. Regenerate with `gen_scorecard.py`.

> `gen_scorecard.py` now mirrors the **live** card, not the source spreadsheet.
> The two had drifted during calibration: the opening item was split into three
> observable acts, the GP/1-in-10 item into two, and the three back-office
> `manual` items were retired with `scripts/remove-manual-items.ts`. Regenerating
> from the spreadsheet would have quietly undone all of that on the next import.
> Re-export from production before editing the generator if there is any doubt.

| File | Items | Notes |
|---|---|---|
| `trustpoint-protection.csv` | 42 | **Recommended.** Live card (47) less the 5 retired on 2026-08-03: 42 AI-scored, no manual items, 6 consent gates, 9 word-for-word, `on_risk`/`referred` branch tags. |
| `trustpoint-protection-on-risk.csv` | 43 | Legacy per-outcome card (superseded, pre-revision). |
| `trustpoint-protection-referred.csv` | 41 | Legacy per-outcome card (superseded, pre-revision). |

## Revision 2026-08-03 (Trust Point QA review)

Trust Point reviewed the first weeks of live scoring and asked for five
checkpoints to come off the card and four to stop failing calls they are happy
with. `gen_scorecard.py` carries the change; `packages/api/src/scripts/apply-scorecard-revision.ts`
(revision `trustpoint-2026-08`) applies the same edits to the live tenant, dry
run by default.

Numbers below are **positions on the live card (v9)** — the numbering Trust Point
read off the app and quoted in their email.

Retired — archived, not deleted, so history and past scores stay intact:

| Live # | Checkpoint | Why |
|---|---|---|
| 3 | Explained the reason for the call | Overlaps 4, which asks the same thing in more detail |
| 25 | Allowed the customer to answer every H&L question | Health & Lifestyle coverage deferred. Also worded so one interruption is a literal fail |
| 26 | Did NOT lead the customer in their H&L answers | Health & Lifestyle coverage deferred. **No H&L checkpoint remains on the card** |
| 32 | Explained add-ons and key policy features | Not every policy has add-ons, and no rule says which do |
| 33 | Checked 'is that all clear?' on add-ons / key features | As 32 — a consent gate on something the policy may not have |

Reworded, with an `expectation` that states what also counts:

| Live # | Change |
|---|---|
| 4 | Position-neutral: counts wherever in the call it is covered, however long the opening runs. The "Intro" section name is a grouping label, never a timing rule — sections are not sent to the model at all |
| 10 | "The key facts will be sent to you" is sufficient; no longer requires email specifically |
| 28 | Recap is judged at the point the sale is closed, not after the H&L questions — a sale with no H&L section is not failed on that basis |
| 30 | Standard terms includes any immediate acceptance; a product with no medical underwriting has no separate "outcome" to state. Also drops "clearly" |
| 31 | Same immediate-acceptance allowance as 30, on the item that judges how the outcome was explained |

### Live numbers vs positions after the revision

`gen_scorecard.py` keeps the live v9 numbering, gaps included, so those email
references keep resolving. **Positions in the generated CSV do not match it** —
retiring five items shifts everything after them (live 30 → position 27, live 34 →
29). Quote checkpoint labels, not numbers, when agreeing the next change.

### Still open on wording

One surviving checkpoint trips the authoring-time wording checks
(`services/checkpoint-quality.ts`) and is worth raising with Trust Point:

- **Live 11** — "policy can be placed in Trust free of charge … where
  applicable": nothing says who decides whether it applies, so the checkpoint can
  be scored on sales it was never meant to cover. Restricting it to the relevant
  products would fix it properly.

### Import
Scorecards → New → Import CSV. The importer reads `label, description,
score_type, weight, severity, section, item_type, branch, expectation,
ai_check, consent_gate`. Branch names in the CSV pre-fill the branch list —
after import, set the **branch keywords** so the scorer can tell the paths apart:

- `on_risk` (default branch — leave keywords empty)
- `referred`: `referred for underwriting, referred to the underwriters, not active yet, no final decision, hasn't declined`

### What the columns drive
- **severity** — drives the breach register (critical/high fails raise breaches).
- **section** — a grouping label for dashboards and coaching. **Not sent to the
  model**, so it never affects a verdict; a checkpoint in the "Intro" section is
  not required to be met early in the call.
- **item_type=manual** — never sent to the AI; lands in the review queue,
  excluded from the AI-scored denominator. None on this card today.
- **branch** — outcome-specific items score only on their branch; on the other
  branch they resolve to `na` and drop out of the denominator. `on_risk`: the
  Direct Debit setup and the two Policy-in-Trust items. `referred`: the "not
  active yet" Direct Debit item.
- **consent_gate=true** — the 6 hard-consent items require an explicit customer
  "yes"; low-confidence speaker attribution routes them to manual review.
- **ai_check** — set on the 9 word-for-word regulatory statements to require
  presence *and* full regulatory meaning.
- **expectation** — extra scoring guidance, separate from the description.
  Carries the "this also counts" boundaries from the 2026-08-03 revision.

## How much goes to a human

Three tenant-level dials decide how much of this card the AI settles on its own,
all set by CallGuard staff on the tenant's admin page:

- **Send to review under (% confidence)** — `review_confidence_floor` (migration
  082). Any checkpoint the model reports below this confidence goes to the review
  queue carrying its provisional verdict, rather than being marked pass or fail.
  Out of the score and the breach register until a person rules on it. **Trust
  Point run this deliberately high**, on their instruction of 2026-08-03: their
  calls are muddy and they would rather rule on marginal checkpoints themselves.

  Pick the number from their own scored sales, not by feel —
  `tsx src/scripts/review-floor-preview.ts "Trust Point"` reports it. Measured
  over 1,459 auto-scored checkpoints on 34 sales (2026-08-03):

  | Floor | To review, per sale | % of card | Sales left with no score | Mean score over the rest |
  |---|---|---|---|---|
  | 0 (off) | 0 | 0% | 0 | 67.1% |
  | 0.70 | 10.1 | 23% | 0 | 81.5% |
  | **0.80** | **19.1** | **45%** | **0** | **86.8%** |
  | 0.85 | 24.0 | 56% | 1 | 87.5% |
  | 0.90 | 35.4 | 83% | 3 | 99.0% |

  **0.80 is the recommendation**: it routes nearly half the card and is the last
  step before sales start coming out with nothing auto-scored at all. Two things
  follow from it and both are worth saying out loud to the client. Their QA team
  picks up ~19 checkpoints per sale. And the reported score jumps ~20 points,
  because the checkpoints the model is least sure about are disproportionately the
  ones it fails — the score now covers only the confident part of the sale, with
  the rest genuinely undecided until someone rules on it.
- **Scoring passes** — `scoring_samples` (migration 076). Above 1, each sale is
  scored that many times and checkpoints the runs disagree on go to review.
  Better-calibrated than the confidence floor, at N× the scoring spend.
- **item_type=manual** — never sent to the AI at all.

## The "Manual Process" items (closed)

The source spreadsheet split its 47 items **38 AI + 9 Manual** without tagging
*which* 9. Three back-office checks were shipped as `manual` and then retired
from the live card with `scripts/remove-manual-items.ts` — Trust Point wanted the
card to contain only what the AI could judge from a recording. **There are no
`manual` items on the card today**, and the confidence floor above is the better
answer to the same problem: it hands the marginal checkpoints to a person without
taking any compliance checkpoint off the card.

Candidates if Trust Point ever want a checkpoint back as `manual` (process checks
a recording alone can't fully evidence): live 43/44 (Trust set-up and trustee
contact, both back-office follow-ups), live 45 (estate-planning follow-up), and
live 16 or 19 (needs-summary quality, features-vs-file accuracy). Flip
`item_type` in the Scorecard Editor; manual items stay on the card and appear in
the review queue.

## Knowledge Base

Ready-to-upload KB content built from the source docs lives in
[`docs/trustpoint/kb/`](../../docs/trustpoint/kb/) — see the README there for the
file → section mapping (company overview, compliance rules, and the three
scripts). Also set Organisation Settings → **Industry / advice domain** to
`FCA-regulated protection insurance advice (life, critical illness, income
protection)`, and configure CloudTalk / Zoho under Integrations so journeys
assemble per sale.

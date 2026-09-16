# Blog content backlog

What the monthly topic scout proposed, what was approved, what shipped, and every
decision the owner made along the way. The scout and the drafter both read this file
first, and both write to it.

It exists for the same reason as the other files in this folder: an agent that knows
"we rejected real-time monitoring terms in Sep 2026, because the intent includes
supervisor alerts we do not send" will not propose it again next month. One that only
knows the principles will.

## How this works

1. **Monthly**, the topic scout proposes 3–5 topics and opens a PR with them, adding
   them here as `status: proposed`.
2. **You pick one** by setting its status to `approved` (in the PR or after merging).
   Anything you reject gets `status: rejected` and one line saying why. That line is
   the point.
3. **On demand**, the drafter takes the first `approved` topic, writes the post as
   `draft: true`, and opens a PR. Merging that PR publishes nothing.
4. **Publishing** is a separate one-line change removing the draft flag, after you have
   read it.

## Standing rules for anything proposed here

- **Audience:** compliance leads at FCA protection and mortgage advice firms.
- **Regulatory topics** need `regulatory-researcher` first, and every citation must end
  up in `handbook-citations-verified.md`. Three posts were held on 15 Sep 2026 because
  this was skipped.
- **No price, and no cost of scoring a call**, in any form a reader could work back
  from. See PRODUCT.md.
- **Thin pages hurt here.** Roughly two thirds of the site is not indexed. Prefer one
  post that earns links from existing pages over three that do not.

## Decisions already made

| Date | Decision | Why |
|---|---|---|
| 2026-09-15 | Guides are the backbone, not news | The audience searches problems; guides survive a research and claims pass that news cannot pay for |
| 2026-09-15 | News only when the FCA or ICO changes what a recorded call must show | The trade press beats us on speed everywhere else, and regulatory writing is where this site has already been wrong |
| 2026-09-15 | No competitor listicles or "top 10 tools" posts | Six comparison pages already have one inbound link each; more thin pages worsen indexation |
| 2026-09-15 | Do not chase real-time monitoring terms | The demand is real but the intent includes supervisor alerts CallGuard does not send |
| 2026-09-15 | Scorecard-anatomy posts are the differentiator | What a rule looks like as a scored criterion is ours to write and cheap to verify |
| 2026-09-15 | Two substantial posts a month, not weekly | Measured competitor cadence: Aveni 6.4/month at 4,500 words with Handbook citations; we cannot win on volume. Voyc is at 1.1/month and silent since 11 Aug, Recordsure silent since 28 Aug, Callytics has no blog — so two researched posts a month is second by cadence and first by specificity. The citation check sustains about two |
| 2026-09-15 | Mix: ~1 scorecard anatomy, ~0.5 reconciliation, ~0.25 original data, ~0.25 news | No competitor publishes the scorecard, and reconciliation has no competitor content anywhere. Original data waits on a fresh production re-run: the published false-positive figures are stale |
| 2026-09-15 | Chase trade-press placement, not trade-press speed | On the Mills Review, Money Marketing and Aveni both published on the day — that speed is what the citation check costs us. But the trade press does not appear on a single solution-intent query. Recordsure gets into Money Marketing and reposts it; one placed comment piece a quarter beats doubling frequency |

## Backlog

**Watch list for the scout.** Two competitors moved in Sep 2026 and both change our
priorities rather than our cadence:

- **Callytics** (no blog, so they will not out-publish us) now describes extracting
  eligibility data from calls in its financial-services case study. That is one step
  short of reconciliation, the one topic with no competitor content anywhere. If they
  ship it, claiming the topic goes from comfortable to urgent.
- **Sedric** is building a UK FCA resource hub citing PRIN 2A.5, COBS 4, ICOBS 2,
  CONC 3 and FG21/1 by designation. "UK-regulated content" is no longer an open gap;
  the scorecard is.
- **Voyc** has published 13 posts in a year and nothing since 11 Aug 2026, with no
  public sign of moving toward reconciliation. If it resumes, re-rank the wedge.

_No topics proposed yet. The first scout run fills this in._

| Slug | Topic | Status | Proposed | Decided | Note |
|---|---|---|---|---|---|

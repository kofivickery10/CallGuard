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

## Backlog

_None yet. The first scout run fills this in._

| Slug | Topic | Status | Proposed | Decided | Note |
|---|---|---|---|---|---|

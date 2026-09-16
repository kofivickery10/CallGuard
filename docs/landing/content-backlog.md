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
  ship it, claiming the topic goes from comfortable to urgent. _16 Sep 2026:_ the case
  study now claims "insurance eligibility verification" as a scorecard requirement and
  lists health conditions among the extracted fields. There is still no public claim of
  comparing them with a submitted application. Treat the trigger as part-fired.
- **Aveni** launched "case-level outcome testing" on 10 Sep 2026. It assesses calls,
  emails, webchat, SMS and supporting documents together as one case. Never write that
  nobody else scores a whole sale. It publishes no claim of checking the call against
  submitted application data.
- **Sedric** is building a UK FCA resource hub citing PRIN 2A.5, COBS 4, ICOBS 2,
  CONC 3 and FG21/1 by designation. "UK-regulated content" is no longer an open gap;
  the scorecard is. _16 Sep 2026:_ 23 items, none about call monitoring, and no
  published criterion wording.
- **EvaluAgent** ranks for "Consumer Duty scorecard template", but the template sits
  behind a form, is marked updated Nov 2024 and cites no rules.
- **Voyc** has published 13 posts in a year and nothing since 11 Aug 2026, with no
  public sign of moving toward reconciliation. If it resumes, re-rank the wedge.

**Regulatory items to watch, none yet a reason for a news post:** FCA MS24/1 pure
protection market study final report (due Q3 2026; interim was 29 Jan 2026); CP26/22
Simplifying the insurance rules, which proposes changes to ICOBS advised sales and
removing ICOBS 4.2 (sources disagree on whether it closed 4 or 19 Sep 2026); the HM
Treasury appointed representatives consultation (closed 9 Apr 2026, no response yet);
the Mills Review perimeter review (the review, published 6 Jul 2026, sets no duties for firms).

**Considered by the Sep 2026 scout and not proposed** (not owner decisions; listed so
next month does not re-run the same search):

- Journey or "call or case" scoring as a post: no search behaviour found for it, and
  Aveni took the term on 10 Sep. Better as a trade-press comment piece.
- Consumer Duty outcomes monitoring and board reports: it would compete with the held
  `fca-consumer-duty-call-recordings` draft, and Aveni dominates those results.
- Call-recording disclosure scripts, and consent-gate as a post of its own: telephony
  vendors own the first; the second is covered inside the demands-and-needs topic.
- "Do we have to record calls?" (SYSC 10A scope): execution-only mortgage sales cut
  across the answer. The mortgage half moves into the execution-only topic.
- Replacement protection business as its own post: it overlaps demands and needs, so
  it becomes that post's worked example instead.
- Mills Review AI-buyer diligence: nothing it says changes what a call must show. A
  placement candidate, not a post.
- Original-data posts: blocked until the production re-run replaces the stale
  false-positive figures.

| Slug | Topic | Status | Proposed | Decided | Note |
|---|---|---|---|---|---|
| non-disclosure-starts-on-the-call | Non-disclosure starts on the call: checking what the customer said against the application | approved | 2026-09-16 | 2026-09-16 | **Rank 1, reconciliation slot.** No competitor content; Callytics trigger part-fired; Aveni now takes in documents but claims no comparison. Needs `regulatory-researcher`: CIDRA 2012 s2, ICOBS 5.1.4G, ICOBS 5.1.1G (new 27 Jul 2026), FOS misrepresentation guidance and the ABI Code (Jul 2023). None is in the verified table yet. Links out to `/application-reconciliation`, `/compare/recordsure-alternative` and `/compare/aveni-alternative`. Keep "application reconciliation" out of the title so it does not compete with the capability page. Risk: implying the adviser owes the CIDRA duty (it is the consumer's, owed to the insurer), or implying a reconciliation accuracy figure |
| icobs-5-2-demands-and-needs-scored-criterion | Demands and needs as a scored criterion: ICOBS 5.2 on a protection call | proposed | 2026-09-16 | | **Rank 2, scorecard anatomy.** Search results show only the Handbook and a paywalled service (estimate). Replacement business is the worked example (ICOBS 5.3.2G(a), existing cover). Needs `regulatory-researcher`: ICOBS 5.2.2R, 5.2.2BR, 5.2.2DR, 5.3.1R, 5.3.2G and 5.3.4R. Only 5.2.1 is in the table, and 5.2.2A is disputed as R or G, so do not cite it. Check the scope of CP26/22 first. Gives `/templates/protection-consent-gate-checklist` its first blog link. Risk: "CallGuard checks ICOBS" (the firm's scorecard defines the checks), or treating demands and needs, which applies to every sale, as suitability, which applies only to advice |
| execution-only-mortgage-call-evidence | Execution-only mortgages after the Mortgage Rule Review: what the call has to show | proposed | 2026-09-16 | | **Rank 3, scorecard anatomy (mortgage).** Replaces a general MCOB 4 post, which would compete with the MCOB template. PS25/11 removed the interaction trigger but kept the customer's positive election. Pages describing the old trigger still rank (estimate). Needs `regulatory-researcher`: PS25/11, MCOB 4.8A, MCOB 4.1.2R and 4.7A for the advised contrast, and MCOB 11.4.2R/11.6.1G to show affordability binds lenders. None is in the table. Risk: repeating the removed trigger, or presenting MCOB 11.6 affordability as an adviser duty |
| complaints-root-cause-from-call-recordings | Root cause analysis from the calls nobody complained about | proposed | 2026-09-16 | | **Rank 4, guide; November.** DISP 1.3 content treats the complaint file as the only input, and no page ties root cause to recordings (estimate). The FCA's outcomes-monitoring good-practice paper (27 Jul 2026, not yet verified) reportedly names call checks and QA scoring. Needs `regulatory-researcher`: DISP 1.3, the FCA root-cause good-practice page and that paper. None is in the table. Link to `score-100-percent-contact-centre-calls` rather than repeating its sampling maths. Risk: presenting the FCA's 13% no-QA figure (all retail sectors, May 2024) as a protection or mortgage figure |

# Product

<!-- impeccable:product-schema 1 -->

Drafted from BRAND_GUIDELINES.md, the live landing copy, the API code and the
owner's answers (14 Sep 2026). BRAND_GUIDELINES.md and DESIGN_SYSTEM.md remain the
authority for identity and UI; this file records product truth only.

## Platform

web

## Users

**Primary:** compliance officers and compliance directors at UK FCA-regulated
protection insurance and mortgage advice firms. Their job is to evidence good
customer outcomes (Consumer Duty, ICOBS, MCOB, FG21/1 vulnerability) across every
sale, when today a senior reviewer can only check a small manual sample of calls.

**Also involved in the decision:** heads of sales or advice who own adviser
performance and coaching, and the firm's operations or IT contact who connects
the dialler and CRM.

Other sectors (contact centres and BPOs, debt collections, outbound sales) are
served by the same engine but are secondary audiences with their own use-case
pages. The homepage leads with protection and mortgage advice.

## Product Purpose

CallGuard AI transcribes and scores every advice or sales call against the firm's
own compliance scorecard, so compliance teams move from sampling to full
coverage. Success means a compliance team can show a regulator systematic,
quote-backed evidence for every sale, find breaches while they are still fixable,
and coach advisers from real calls, without adding reviewers.

## Positioning

- **Evidence, not opinion.** Every pass and fail shows the transcript evidence it
  was decided on, which is what an auditor, the FCA or a complaints handler asks to
  see. A criterion with nothing relevant on the call is recorded as "no relevant
  evidence found", so not every verdict carries a quote.
- **The firm's interpretation, not a generic one.** When a compliance officer
  corrects a verdict, up to five of the most recent corrections on that criterion
  are shown to the AI as examples the next time it scores that criterion, alongside
  gold-standard exemplar calls — so the AI sees how your firm has read that
  criterion before, not only the scorecard's words. There is no measured
  improvement, convergence or accuracy figure; never write "learns", "converges",
  "scores like", "gets better", "moves the scoring towards" or "drifts towards".
- **The sale, not just the call.** Multiple calls with one customer are scored
  together as one compliance unit (a journey), triggered by the sale in the CRM.
- **Call checked against paperwork.** Reconciliation compares what the customer
  said on the call with the answers submitted on the insurer's application.
- **Personal data redacted before scoring.** Names and other personal, payment and
  health details are replaced with tags in the transcript before it is stored or
  scored. Not absolute (claims audit, 14 Sep 2026): call audio is stored encrypted,
  the transcription provider receives raw audio, tenants can switch off some
  redaction categories (payment data stays on), and the insurer-form profile learner
  sends unredacted application text to Claude. Never write "personal data never
  reaches the AI".

## Operating Context

- Calls arrive from the firm's own dialler, whichever it is: through the CloudTalk
  connector, SFTP pickup of any dialler's recording export, recording upload over
  the REST API (Teams and Zoom video included), or live streaming from Twilio Media
  Streams, Amazon Connect (through a customer-run Lambda bridge) or the generic
  WebSocket protocol.
- The CRM is part of the workflow: a sale in the CRM starts journey scoring, and
  scores and breach tasks are written back to the firm's QA module. Zoho CRM is the
  connector already built; for any other CRM, CallGuard builds the same connection
  during setup (owner, 15 Sep 2026). Results also reach any system through signed
  webhooks and the results API.
- Firms bring their own scorecards, QA manuals and product checklists.
  Consent-gate items go to a manual review queue when CallGuard can't reliably
  tell which speaker is the customer — that's speaker attribution from
  transcription, not the AI's confidence in its verdict. If a sale's main call
  can't be attributed at all, every checkpoint on that sale goes to review.
  Routing is per checkpoint, not per call. A threshold on the AI's own
  confidence exists too, but it is off by default.
- Insurer application PDFs are parsed for Reconciliation.
- Outputs: per-criterion pass/fail with transcript evidence, a weighted score,
  breach alerts (in-app, email, Slack, webhooks), adviser coaching drafts, AI
  insights briefs generated on request, and an evidence pack.
- Roles: admin, supervisor, viewer and adviser (advisers see only their own calls).

**Copy rule: your dialler, your CRM.** Never present CloudTalk or Zoho CRM as the only
dialler or CRM CallGuard works with. Lead with "your dialler" and "your CRM", and name a
product only where the sentence is about that connector. CRM work is something CallGuard
connects for the firm: do not name or imply ready-made Salesforce, HubSpot or other
connectors, and do not imply that connecting a non-Zoho CRM is self-serve.

## Capabilities and Constraints

**Confirmed in the codebase:** transcription with speaker separation and
transcript redaction (tenant-configurable); per-call and journey scoring with
transcript evidence (all criteria scored in one model call); live streaming and
mid-call breach detection (the rolling transcript is re-checked every 30 seconds,
stream-worker.ts:33, and a breach is sent only at 0.75 model confidence or higher,
live-scorer.ts:155; write "0.75 or higher", never ">75%", and never promise how fast
an alert arrives), sent to the streaming client or a webhook, not to
supervisors; webhooks, HMAC-signed when a signing secret is set; corrections-based
learning and exemplar library; coaching memory and AI insights briefs on request
(not scheduled); journey calls matched by phone number within a sale window;
scoring calibration detail (claims audit, 14 Sep 2026; fix in progress, separate
PR, so do not publish these three limitations on any customer-facing page): the
five most recent corrections shown per criterion are drawn from the latest fifty
corrections logged across the scorecard being scored, and a criterion whose
corrections have all aged out of that window gets none; checkpoints held for
review (consent items where the speaker can't be told apart) are scored with no
calibration examples; coaching memory only appears on calls scored individually,
so sale-scored coaching does not yet see an adviser's prior coaching drafts.
Customer-facing copy should say only "up to five of the most recent corrections
on that criterion are shown to the AI as examples", and for coaching, that
individually-scored calls use the adviser's last three drafts, without stating
what sale-scored coaching lacks;
Reconciliation (switched on per firm by CallGuard staff; runs once the insurer application
PDF is on the sale record in the firm's CRM, through the Zoho connector in the code today; listed on the Pro plan on pricing.html); CloudTalk and Zoho CRM connectors built, with other diallers through SFTP, upload and the API, and other CRMs connected by CallGuard during setup;
AES-256-GCM encryption at rest; manual review queue; adviser remediation
(what the adviser did about a finding).

**Published facts:** three plans, Starter, Growth and Pro, with live streaming, journey
scoring and Reconciliation listed on Pro; the owner decided on 15 Sep 2026 that no price is ever shown
publicly — plans are quoted per seat for the team size, and pricing.html carries no £
figure. The code's plan gates differ from pricing.html (e.g. learning and coaching on
every plan, live streaming from Growth; plans named Core/Professional/Enterprise); DPA and
sub-processor list published; CallGuard AI Ltd, company number 17279006,
registered in England and Wales; founded by Kofi Vickery and Charlotte Court.
Customer data (audio, transcripts, scores) is stored in a UK region (confirmed by
the owner, 14 Sep 2026; AWS London per the DPA). Audio and transcripts are also
processed by sub-processors outside the UK, so "stored in the UK" is always paired
with the sub-processor list.

**False, never repeat (claims audit, 14 Sep 2026):** "personal data never reaches the
AI"; "every verdict quoted"; "weekly" insights; live breach alerts to supervisors;
"learns", "converges", "scores like", "moves the scoring towards" or "drifts
towards" (no measured improvement, convergence or accuracy figure exists; the true
wording is that up to five of the most recent corrections on a criterion are shown
to the AI as examples the next time it scores that criterion, so it sees how the
firm has read that criterion before, not only the scorecard's words); "one-click
correction" (correcting a verdict is choose Pass or Fail, an optional reason, then
Save — never "one click");
"one criterion at a time"; "gathers every call with that customer"; "the four
Consumer Duty outcomes" evidenced on a call (only PRIN 2A.5 and 2A.6 are
call-visible); MCOB affordability as an adviser duty (MCOB 11.6 binds lenders);
"correction applied" (a correction is one of up to five calibration examples; the AI can
still decide otherwise); "when the AI isn't confident, it goes to review" (the AI-confidence
floor is off by default; what always routes a consent item to review is uncertainty
about who answered it); "streamed calls are scored the same as recorded calls" (consent
questions on streamed calls always go to review, no clean-up pass, no audio kept);
"live mid-call scoring" (live is breach detection only); webhooks called "signed"
without "when a secret is set"; "CallGuard checks ICOBS/MCOB …" (the firm's scorecard
defines the checks); firms "choosing" to disable redaction (only CallGuard staff can,
with a DPIA note); "bring five of your own recordings" to a demo (a DPA comes before any
real recordings; demos use synthetic calls); any CallGuard price, or "published pricing",
on a public page (owner, 15 Sep 2026: never show a price, we can keep the plans);
the cost of scoring a call — per call, per minute, or as a multiple of manual
review — because a cost alongside a quote gives away the margin (owner, 15 Sep 2026).
That bars the derivable form too: a manual cost per call plus "orders of magnitude
below" is the same disclosure with a division in the way.

**Demo:** don't state a demo length (owner, 14 Sep 2026); demos use synthetic calls, and a DPA
comes before any real recordings; replies usually the same working day.

**Claims that need verification before any page repeats them:** "a 15-minute call with
an engineer, not a salesperson"; "scored in under a minute"; "100 calls
scored before lunch"; "within 30
seconds" webhook delivery; "the audit trail the FCA expects"; "GDPR-compliant by
default"; the 5–10% industry sample rate and 60–90 minute review time (unsourced).

**Not built (roadmap only, never presented as available):** live in-call AI
coaching; native iOS/Android field-sales capture.

**Terminology:** "dialler" (UK spelling); "adviser"; "sale" / "journey" for a
multi-call customer unit; "breach" for a critical scorecard failure.

## Brand Commitments

- Name: "CallGuard AI" on first use, "CallGuard" thereafter. Standalone product,
  never co-branded with any other company or product.
- Logo: shield carrying a five-bar equaliser; wordmark with "AI" in primary green;
  use the supplied lockups in `landing/brand/` unaltered, dark variants on dark
  grounds.
- Personality: the expert analyst — calm, precise, trustworthy; never alarmist,
  never flippant. Plain, direct UK English; state facts, then the action; no hype,
  no emoji.
- The redesign keeps the brand palette (primary green, pass/fail/review status
  colours, green-tinted neutrals) and Inter, per BRAND_GUIDELINES.md. It may
  extend them for marketing scale but not replace them.
- Strapline: "Smarter calls. Safer business." Positioning statement in
  BRAND_GUIDELINES.md ("Every sales conversation, scored live by AI that learns
  from your compliance team") is false on two counts and should not be repeated
  on customer-facing pages: "live" (only breach detection runs live; scoring
  itself is post-call) and "learns" (no measured improvement; the AI is shown
  your compliance team's corrections as examples, it does not learn or converge).

## Evidence on Hand

- Brand assets: `landing/brand/` (SVG and PNG lockups, icon, mono marks, favicon).
- The real product UI in `packages/web`, runnable locally against the seeded
  demo tenant "Brookfield Protection" (synthetic data; label anything taken from
  it as a demo).
- Plans quoted per seat, published DPA, sub-processor list, founders and company details.
- Downloadable templates: protection consent-gate checklist, MCOB mortgage scorecard.
- **Absent, must not be fabricated:** customer testimonials, case studies,
  customer logos, named clients, accuracy benchmarks, ROI figures. A live client
  exists, but it is not named or quoted anywhere without its written consent.

## Product Principles

1. Show the evidence: every claim on a page is either demonstrated or verifiable.
2. The firm's compliance judgement leads; the AI follows it.
3. Privacy by design is a feature, not a footnote.
4. Honest and published: legal documents and limits are visible; plans are named and
   explained, quoted per seat rather than priced on the page.
5. Calm precision: reassure with facts under regulatory pressure, never with fear.

## Accessibility & Inclusion

WCAG 2.1 AA across the marketing site, in light and dark themes, with reduced
motion honoured. The measured baseline lives in
`docs/landing/accessibility-baseline.md`.

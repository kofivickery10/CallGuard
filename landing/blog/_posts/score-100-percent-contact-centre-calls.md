---
title: "How to score 100% of contact centre calls without hiring more QA staff."
ogTitle: "Score 100% of Contact Centre Calls"
breadcrumb: "Score 100% of contact centre calls"
description: "The QA bottleneck explained from first principles, the maths of manual vs AI scoring, and what 100% call coverage looks like in production."
ogDescription: "The QA bottleneck explained from first principles, plus the architecture of 100% coverage in production."
twitterDescription: "The QA bottleneck explained from first principles, plus the architecture of 100% coverage."
cardTag: "Operations · Contact centres"
cardSummary: "The QA bottleneck explained from first principles, the maths of manual versus AI scoring, and what the architecture of 100% coverage actually looks like in production."
order: 4
date: "2026-05-05"
section: "Operations"
readingTime: 11
wordCount: 1700
ctaSubject: "CallGuard%20AI%20%E2%80%94%20BPO%20demo"
useCaseLink: "/use-cases/bpo"
related:
  - fca-consumer-duty-call-recordings
  - what-is-ai-call-qa
---

If you run QA in a contact centre, you already know the maths. A senior reviewer takes 15 to 30 minutes to score one call against your scorecard. They review maybe 20 calls a week. Your floor takes 50,000 calls a week. The reviewed sample is 0.04%. Adding more QA reviewers shifts the rate to 0.08%, then 0.12%, but it never gets close to a number anyone in operations would call coverage. This piece is about the architecture that gets you to 100%.

## The QA bottleneck, from first principles

The bottleneck is not lack of will. Most QA teams would love to review more calls. The bottleneck is unit cost. A reviewer scoring 4 calls per hour at a fully-loaded UK senior wage of, say, £45,000 plus 25% overheads, costs roughly £35 per scored call once you net out admin time. At a 50,000-call-per-week floor, full coverage by humans would cost £1.75m per week or £91m per year. Nobody approves that budget, so you sample.

Sampling looked acceptable when "auditable evidence" meant a binder of reviewed-call summaries on a shelf. It is much harder to defend now that regulators expect systematic monitoring (post-Consumer Duty in financial services, post-PECR for outbound) and clients expect programme-level visibility from BPOs in real time. The sampled-call binder is no longer the answer to the question being asked.

## Why hiring more QA reviewers does not scale

The intuitive response to a QA bottleneck is "hire more reviewers". It does not work, for three reasons.

**Linear cost, sublinear value.** Doubling reviewers doubles cost. It also doubles the variance between reviewers, since two senior reviewers reading the same call will score it differently. Inter-rater reliability is rarely measured because it usually exposes a depressing number. The more reviewers you hire, the more important calibration becomes, and the time you spend calibrating cuts into the time available to review.

**The next call is not the bottleneck call.** Reviewers cannot pick the calls that matter most because they cannot see what is on a call before they listen to it. They sample randomly or by length, hoping to catch breaches. The breaches you actually need to find are on the calls outside the sample.

**Reviewers burn out.** Listening to 30 calls a day for compliance failures is grim work. Senior reviewers leave for coaching roles, agent ops roles, or out of the industry. The team you build erodes faster than you can rebuild it.

## The maths of AI scoring

AI call scoring removes the unit-cost barrier that made sampling necessary. Speech recognition costs about £0.005 to £0.01 per call-minute today. Large language model scoring against a structured scorecard costs another £0.02 to £0.05 per call-minute, depending on the model and the scorecard length. A 6-minute call costs roughly 30 to 60 pence to score in full, including the transcript. At 50,000 calls a week with average 5-minute duration, full coverage is £75,000 to £150,000 per year. Two orders of magnitude cheaper than the human equivalent.

The cost is not the headline though. The headline is what you can do with 100% coverage that you cannot do with 5%. [We covered the foundations of how AI call QA works in a separate post](/blog/what-is-ai-call-qa), but here are the operational consequences specific to contact centres.

## What 100% coverage actually unlocks

**Breach detection in seconds, not weeks.** A critical compliance failure (urgency-language, missing consent capture, mini-Miranda failure, fair-value misstep) is currently caught when a customer complains weeks later. With live mid-call scoring, a high-confidence breach fires a webhook to your supervisor screen within 30 seconds of the AI being sure it has happened. Coaching can be in the next call rather than the next month.

**Real coaching, on every agent, every week.** Per-call coaching drafts feed into per-agent coaching memory. The coaching the agent receives next time builds on what was said last time. If they have improved on the flagged area, the AI acknowledges it. If they have not, the language escalates. Manual QA cannot do this because no human has the time to remember every coaching note for every agent.

**Agent risk profiles, accurate to the call.** A heatmap of which agents are driving which breach types becomes possible because every call is scored. Today, agent performance reviews are anchored on three or four reviewed calls and a wall of subjective impressions. With AI scoring, agent risk is a number computed across hundreds of conversations, not a folk theory.

**Client reporting in real time.** BPOs running multi-tenant programmes can give each client a scoped portal with their own scorecard, their own breach register, and their own pass rate trend. This replaces the multi-person reporting team that currently produces monthly PDFs. It is the reporting pattern our [contact centre and BPO QA](/use-cases/bpo) setup is built around.

**Capacity decoupled from QA headcount.** If the QA bottleneck disappears, you can grow agent headcount without first hiring more reviewers. The unit economics of adding seats stops including a QA staffing tax.

## The architecture of 100% coverage

What does the system actually look like? Five components, each of which is built into the platform today.

### 1. Audio ingestion

Calls have to get into the system. There are three patterns:

- **Live streaming over WebSocket** from your dialer. Twilio Media Streams and AWS Connect Voice Streams are the most common. [Our Twilio integration](/integrations/twilio) and [AWS Connect integration](/integrations/aws-connect) walk through the wiring. Other dialers connect via a generic WebSocket protocol.
- **Batch upload of recordings** via REST API or the dashboard. Useful for legacy stacks where streaming is not available, or for archived recordings being scored retrospectively.
- **Drag-and-drop** for one-off calls being reviewed in the dashboard.

The streaming path adds the ability to do mid-call breach detection. The batch path is otherwise functionally identical, just without the live alerts.

### 2. Speech recognition with diarisation

Production-grade ASR converts audio to a transcript with speaker separation. Word-error rate matters less than diarisation accuracy and keyterm boosting (so product names and acronyms specific to your business get recognised correctly). The output is a structured transcript with agent and customer turns, plus timestamps.

### 3. LLM scoring against your scorecard

The transcript goes to a large language model with your scorecard. The model scores each criterion individually, returns a verdict, and returns the direct quote from the transcript that justifies the verdict. The evidence quote is the part that matters: a score with no evidence is unauditable.

### 4. Per-tenant calibration

Your compliance team corrects AI verdicts they disagree with, marks gold-standard calls as exemplars, and provides written guidance through a knowledge base. All three feed into the prompt the next time the AI scores. After 50 to 100 corrections, the AI scores like your senior reviewer rather than a generic baseline. This is what makes AI call QA stick rather than drift.

### 5. Output integration

Results need to land where the people who act on them are working. That means three integration paths:

- **Dashboard** for QA leads, ops directors and compliance officers who want to review individual calls.
- **HMAC-signed webhooks** for live breach alerts to your supervisor screen, CRM or Slack.
- **REST API** to pull scores back per call so you can render them inside your own client portal, agent desktop or case-management system.

## What QA staff do once full coverage is the default

The honest answer: they do better work. The 1% sample reviews disappear because the AI does them all. What remains is high-leverage human work that AI cannot do.

**Calibration of the AI.** Senior reviewers correct edge cases the AI got wrong. Each correction makes the AI better at scoring like your firm. This is the highest-leverage QA work in the new world: every correction made by one reviewer becomes a few-shot example used on every future call. One person's judgement scales across the floor.

**Coaching delivery.** The AI generates the coaching draft. A human delivers the coaching conversation. The shape of coaching shifts from "we listened to your call yesterday and noticed" to "we have noticed across your last 40 calls that". Coaching becomes data-driven rather than anecdote-driven, and that lands harder with agents.

**Compliance review of flagged calls.** The AI flags critical breaches; humans review them, decide on severity, escalate where needed, and document the resolution. The breach register becomes the operational artefact, not the spreadsheet of reviewed calls.

**Programme-level analysis.** Patterns across the floor: which scorecard items are getting harder to pass, which agents are improving, which campaigns have rising breach rates. AI-generated insights digests give compliance leads a strategic view that nobody had time to build manually.

## An ROI sketch you can adapt

This is the rough working we use with prospects. Treat it as illustrative, not precise.

A 100-seat outbound contact centre takes roughly 80,000 calls per month at 4-5 minute average duration. Manual QA at 5% sample is 4,000 reviewed calls per month at £30-£35 per call, or £130k a month. Manual QA at 1% sample (more typical) is around £25-£30k a month, with the trade-off of being less defensible to clients and regulators. AI scoring on 100% coverage at 6-minute average duration costs £6-£10k per month for the same scoring depth, with the additional value of mid-call breach detection on outbound campaigns. The arithmetic only goes in one direction.

That said, ROI on a tool the regulator now expects is the wrong metric. The right metric is whether your firm can credibly answer "how do you systematically monitor outcomes" without flinching. Sampling does not.

## Where to start

If your contact centre or BPO is at the point where adding more QA staff has diminishing returns, the right next step is to score a sample of your real calls and see what AI actually catches that your sample missed. We run 15-minute demos against five recordings you bring; you see your scorecard, your breaches, and your coaching drafts on the call. [Email hello@callguardai.co.uk](mailto:hello@callguardai.co.uk?subject=CallGuard%20AI%20%E2%80%94%20BPO%20demo) and we will book it in.

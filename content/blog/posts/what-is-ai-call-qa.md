---
title: "What is AI call QA and how does it actually work?"
ogTitle: "What Is AI Call QA and How Does It Actually Work?"
breadcrumb: "What is AI call QA"
description: "A plain-English walkthrough of how AI call quality assurance works: speech recognition, large language models and per-tenant calibration."
ogDescription: "A plain-English walkthrough of how AI call quality assurance works."
schemaDescription: "A plain-English walkthrough of how AI call quality assurance works."
cardTag: "Foundations · AI call QA"
cardSummary: "A plain-English walkthrough of how speech recognition, large language models and per-tenant calibration combine to score your team's calls against your scorecard."
order: 5
date: "2026-05-05"
updated: "2026-09-15"
section: "Foundations"
topic: "foundations"
author: "kofi"
featured: true
ctaSubject: "CallGuard%20AI%20demo%20request"
useCaseLink: "/use-cases/financial-services"
related:
  - score-100-percent-contact-centre-calls
  - ai-vs-human-call-scoring
  - fca-consumer-duty-call-recordings
  - pecr-tps-2026-outbound-compliance
---

If you have ever sat through a "QA round-up" meeting where a supervisor reviewed five recorded calls in front of a room full of agents, you already understand the problem with manual call quality assurance. It is slow, it is biased toward the calls a human happened to pick, and 95% of the conversations your team had that week never get reviewed at all. AI call QA replaces that with something the data warehouse already does for sales and CSAT: full coverage, scored consistently.

## What "AI call QA" actually means

AI call quality assurance is the use of speech recognition combined with large language models to transcribe and score every call your team takes against a structured scorecard. Every call. Not a sample.

The output is the same shape as a manual QA review: pass / fail per criterion, an overall weighted score, the transcript evidence each verdict was decided on, or a note that none was found, and a coaching draft for the agent. The difference is that you get this output for every call you score, shortly after it ends, rather than for a small sample weeks later.

For regulated voice work, like FCA-regulated financial advice or contact-centre outbound, the leap matters more than it sounds. Manual sampling is statistically blind to the calls outside the sample. AI scoring is not.

## The three pieces that make it work

Underneath the dashboards, an AI call QA system is three things glued together: a speech-to-text engine, a large language model running against a scorecard, and a per-tenant calibration layer.

### 1. Speech-to-text with speaker separation

Production-grade speech recognition (sometimes called automatic speech recognition or ASR) converts the audio into a written transcript. For QA work, the engine needs three things on top of plain transcription: **speaker diarisation**, so the agent's words can be distinguished from the customer's; **keyterm boosting**, so product names and acronyms specific to your business get recognised correctly; and **punctuation and capitalisation**, because a model scoring downstream depends on having sentence boundaries.

Modern ASR achieves word-error rates well under 10% on UK English with good audio quality. The remaining errors mostly cluster on regional accents, technical jargon and overlapping speech, which is why keyterm boosting matters more than people realise.

### 2. A large language model running against your scorecard

The transcript goes to a large language model (in CallGuard's case, Anthropic's Claude). The model is shown your whole scorecard in one pass, told to score each criterion against the transcript, and asked for two things back per criterion: a verdict (pass or fail), and the direct quote from the transcript that proves the verdict.

That second part matters more than the first. A score with no evidence is just an opinion. A score with a quote underneath it is auditable. If your compliance officer reviews 50 scored calls and disagrees with a verdict, they can see exactly which words drove the AI to that conclusion and override it. That is the basis of an audit trail the FCA actually expects.

### 3. Per-tenant calibration

This is the bit that distinguishes a serious AI QA system from a wallpaper one. Generic LLM scoring drifts. The model's interpretation of "fair value" or "vulnerable" is whatever happened to be in its training data, not your firm's interpretation.

The fix is not to fine-tune the model (slow, expensive, often regresses on edge cases). The fix is to feed the model your own corrections and exemplars as context every time it scores, and prior coaching drafts as context when it writes a new one. When your compliance officer corrects a verdict, up to five of the most recent corrections on that criterion are shown to the AI as examples the next time it scores that criterion. They are examples rather than rules: the AI can still reach a different verdict on a call that genuinely differs. That is the mechanism that lets one engine serve a financial planning firm, a debt-collection BPO and a customer-support contact centre without each customer having to fine-tune anything. [More on how scoring calibration works.](/scoring-calibration)

## What gets measured

The scorecard is yours, not the vendor's. That is the most important sentence on this page. A serious AI QA system scores against the structured scorecard your firm already uses, not a one-size-fits-all template.

For financial services advice, that scorecard typically encodes ICOBS 5 suitability checks, FG21/1 vulnerable client indicators, charges and Consumer Duty fair-value tests, and DB-transfer specialist-pathway gates. [We cover financial services scoring in detail elsewhere on the site.](/use-cases/financial-services)

For a contact centre, the scorecard typically covers empathy and rapport, first-call resolution, compliance and consent, product knowledge, escalation handling, and outbound regulatory rules (TPS list checks, PECR caller identification and objections, mini-Miranda statements where applicable). [More on contact centre and BPO scoring here.](/use-cases/bpo)

The point is that the engine does not care what regime you are scoring against. It cares that each criterion is well-defined and that the verdict can be justified by a quote.

## Live versus after-call scoring

There are two operating modes worth understanding. Most legacy speech analytics tools only do the second.

**After-call scoring** processes the recording once the call has ended. The transcript and score are ready shortly after. This is appropriate for compliance review, breach detection, agent coaching and reporting. It is also the only mode you need if your audio is uploaded as files (recordings from a dialer, exported from a compliance recorder, or pushed in via API).

**Mid-call breach detection** runs while the conversation is still happening. Audio streams over a WebSocket from the dialer (Twilio, Amazon Connect via a customer-run Lambda bridge, generic WebRTC). The system transcribes live, checks a rolling transcript for breaches, and emits high-confidence breach alerts via webhook, HMAC-signed once you set a signing secret, to your CRM or agent desktop before the call ends. This mode matters for outbound campaigns where a critical breach (urgency language, an ignored objection to marketing, a missed mini-Miranda) is regulator-grade and you need to intervene mid-call rather than file a finding three weeks later.

Both modes use the same scorecard and the same calibration layer. The mid-call mode adds a confidence threshold, so it only emits a breach when it is confident the criterion has already failed, rather than firing on every borderline signal.

## Common myths

**"AI call QA is just sentiment analysis."** No. Sentiment analysis is one cell on the scorecard. AI QA scores arbitrary scorecard items, including binary compliance checks (was the consent statement read), categorical judgements (was the recommendation suitable for the disclosed risk profile), and weighted scoring (how clearly were charges disclosed on a 1 to 5 scale). Sentiment is rarely the headline use case.

**"It will just give every call a high score."** Without corrections and exemplars to draw on, models do tend toward leniency on subjective items. When your compliance officer corrects a verdict, that correction becomes an example shown to the AI the next time it scores that criterion, so it has your compliance officer's reading to draw on rather than only the scorecard's words.

**"It's just transcription with summarisation slapped on top."** Summaries are non-auditable. AI call QA produces a structured per-criterion verdict with the transcript evidence underneath. That is the difference between a feature and a compliance tool.

**"It will replace QA staff."** It changes what QA staff do. The volume of calls reviewed goes from 1-5% to 100%, and humans spend their time on the calls the AI flagged for review (low scores, critical breaches, ambiguous evidence) rather than randomly sampling. Most contact centres redeploy QA staff into coaching rather than off the payroll.

## Who needs it

Three groups, in roughly this order of urgency:

**FCA-regulated firms under Consumer Duty.** PRIN 2A.9.8R asks firms to regularly monitor the outcomes their retail customers receive. It sets no sample size and does not require reviewing every call. But a 5% sample answers a question about that 5%, and if your compliance officer is being asked what happened to everyone else, AI call QA is one of the few ways to answer it.

**Contact centres and BPOs at scale.** Anyone running more than 50 seats hits the same wall: hiring more QA staff does not scale, sample sizes have to drop as call volume rises, and clients increasingly demand programme-level visibility that a monthly PDF report cannot provide. AI scoring breaks the curve.

**Outbound and field sales operations.** Anywhere a single bad call can become a regulatory problem (urgency language, an objection ignored, a caller who won't give their name), the cost of missing one in your sample is asymmetric. AI makes it practical to score every call rather than a sample.

## How to evaluate AI call QA software

If you are about to demo three or four products, the questions worth asking are these.

**Can I bring my own scorecard?** If the answer is "we have a template you can edit", be cautious. A serious AI QA system runs against an arbitrary scorecard you upload, not a vendor-curated set of items.

**Where is the evidence?** Every verdict should show the transcript evidence it was decided on, or say plainly that no relevant evidence was found. If the product cannot show you what drove the score, it is not auditable.

**Can compliance officers correct AI scores, and are those corrections used again?** The honest answer should be specific: a vendor should be able to tell you exactly how many recent corrections on a criterion are shown to the AI as examples the next time it scores that criterion, and show you the evidence and reason behind each one — not just claim the system "learns".

**Does it stream live or only batch?** Both modes have different value. If you are scoring outbound campaigns, the lack of mid-call alerts is a deal-breaker. If you are scoring recorded advice files, you may not need live at all. Know which mode the regulator cares about for your use case.

**How do I get the data out?** If results are locked inside the vendor's UI, integrating with your CRM, agent desktop or compliance case-management system becomes a custom-build project. A REST API that returns the per-call score plus evidence in JSON should be table stakes.

## What this looks like in practice

If you want to see what an AI-scored call looks like end to end (transcript, per-criterion verdicts, transcript evidence, breach register, coaching draft) we run a short demo scoring synthetic calls against a scorecard like yours. [Drop us a line at hello@callguardai.co.uk](mailto:hello@callguardai.co.uk?subject=CallGuard%20AI%20demo%20request) and we will set it up; when you want to try your own recordings, we put a DPA in place first.

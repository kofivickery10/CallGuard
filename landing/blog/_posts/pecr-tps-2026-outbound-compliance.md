---
title: "PECR and TPS in 2026: practical compliance for outbound teams."
ogTitle: "PECR/TPS 2026 Compliance for Outbound Teams"
breadcrumb: "PECR and TPS 2026"
description: "Practical PECR and TPS compliance for outbound teams in 2026: what's tightened, what's blurred, and how to evidence systematic monitoring."
ogDescription: "What's tightened, what's blurred, and how to evidence systematic monitoring."
cardTag: "Compliance · Outbound"
cardSummary: "What's tightened, what's blurred, and the five things the ICO will ask if a PECR complaint reaches them. Plus the systematic-monitoring standard that has replaced sample-based QA."
order: 1
date: "2026-05-05"
time: "10:00"
section: "Compliance"
readingTime: 9
wordCount: 1500
ctaSubject: "CallGuard%20AI%20%E2%80%94%20PECR%20demo"
useCaseLink: "/use-cases/outbound-sales"
related:
  - fca-consumer-duty-call-recordings
  - score-100-percent-contact-centre-calls
  - ai-vs-human-call-scoring
---

PECR is one of those regulations that contact-centre operators reference in passing without ever really sitting with. Then the ICO knocks, and what was a footnote becomes the only thing the leadership team is talking about. This piece is what an outbound compliance lead needs to know about PECR and TPS in 2026: what changed, what is being enforced more aggressively, and how to evidence systematic monitoring on the calls themselves.

## The short version

PECR (the Privacy and Electronic Communications Regulations) governs unsolicited marketing calls in the UK. The TPS (Telephone Preference Service) is the central register of consumers who do not want to receive marketing calls; the CTPS is the corporate equivalent. Together they create the regime UK outbound teams have to dial within.

Three things have shifted enforcement-side over the last two years and one is pending in 2026:

1. The ICO has been issuing higher monetary penalties for systemic PECR breaches, with seven-figure fines for repeat offenders
2. Consent capture is being scrutinised more carefully, with consent obtained "as part of" a registration form increasingly viewed as insufficient
3. "Soft opt-in" exceptions for existing-customer marketing are being interpreted more narrowly
4. The Data (Use and Access) Bill (currently in parliamentary process) may further refine the consent rules during 2026

The practical effect is that the cost of getting it wrong has increased, and the practices many outbound teams have relied on for years (broad consent capture, generous soft-opt-in interpretation, sample-based call-monitoring) are no longer adequately defensible.

## What PECR actually requires on the call

PECR is sometimes described as a list-checking regime, but the on-call requirements are broader than just "did we honour the TPS register". Five things should be evidenced on every regulated outbound call:

### 1. Caller identification, within 30 seconds

The agent identifies themselves, the firm, and the purpose of the call promptly. Not buried after the qualification questions. Calls where the agent hides who they are calling on behalf of until the customer has confirmed details are non-compliant on day one.

### 2. Specific consent for the call (where required)

If the call is to someone who is not an existing customer, you need explicit consent for marketing calls from that person. Not implied consent. Not "they ticked a box on a website three years ago that mentioned partners". The consent has to be specific to the type of call you are making and the firm making it.

### 3. Honouring TPS / CTPS registration

Calls to TPS-registered numbers without specific consent are a PECR breach. The dial-time check happens upstream of the call (in your dialler), but on the call itself, if the customer mentions their TPS registration, the agent's response is part of the compliance record. "I see" and continuing the pitch is non-compliant.

### 4. Recording disclosure where required

If you are recording the call (which you almost certainly are), the customer should be informed at the start of the call. Recording disclosure that is mumbled, rushed, or missing entirely is a separate compliance issue from the marketing-consent question, and is being scrutinised more in 2026.

### 5. Right to opt out, captured if used

The customer's right to end the call and opt out of future calls is unconditional. If they exercise it, the agent should acknowledge the request and not press past it. Calls where the customer has tried to disengage three times and the agent persists are PECR-relevant on top of being conduct-rule-relevant.

## How "systematic monitoring" became the standard

For most of PECR's lifetime, "we sample our calls and the QA team checks for these things" was an acceptable answer to the ICO's "how do you monitor compliance" question. That has shifted, and the shift mirrors what happened in financial services after Consumer Duty: the regulator increasingly expects to see systematic evidence on every call, not statistical extrapolation from a sample.

The phrase "systematic monitoring" appears in ICO PECR enforcement notices with increasing frequency. The implication is that "we sample 5%" is not adequate evidence of monitoring; the regulator wants to see that you are checking the items above on every call, that breaches are flagged when they happen, and that your firm has an audit trail when it remediates.

Sample-based QA cannot produce that evidence. AI scoring on 100% of calls can. [Our outbound sales use-case page covers this in more detail.](/use-cases/outbound-sales)

## The interaction with Consumer Duty (where applicable)

For outbound teams selling FCA-regulated products (insurance, energy, mortgages, regulated lending), PECR sits underneath Consumer Duty's four outcomes. A PECR-compliant call can still fail the Consumer Duty test if the price-and-value framing, the consumer-understanding check, or the consumer-support pathway are weak.

The two regimes are complementary rather than overlapping. PECR governs whether the call should have happened at all and how it was conducted at the meta-level. Consumer Duty governs whether the recommendation made on the call was suitable, fair and understood. [More on Consumer Duty evidence here.](/blog/fca-consumer-duty-call-recordings)

## What the ICO actually looks for in an investigation

If your firm receives an ICO enquiry following a PECR complaint, the questions you can expect are roughly these:

1. **Where did the consent for this call come from?** Show the documentary trail from the original consent capture to the dial-time decision to call this number. Generic "they ticked a box" answers do not satisfy.
2. **How do you monitor compliance on outbound calls?** The expected answer is systematic monitoring of every call against your scorecard, with a breach register that shows what was flagged and what was remediated. "We sample 5%" lands poorly.
3. **Show me the recording of the call this complaint relates to.** If the recording is missing, your problem is bigger than PECR. If the recording exists but you have not scored it for compliance, the regulator's question is "why not".
4. **What did your supervisor do when they noticed the breach?** If the breach was caught mid-call (live AI alert, supervisor intervention) and remediated, you have a much better story than if the breach was discovered four weeks later in a sample audit.
5. **What systemic action did you take after the breach?** Was the agent coached? Did the scorecard get updated? Did training change? The audit trail showing closed-loop remediation is the answer the ICO wants.

Five questions, all of which point at one architecture: systematic per-call scoring, mid-call breach detection, integrated coaching loop, and an audit register that shows the closed loop from breach to remediation.

## What an "audit-ready" outbound operation looks like in 2026

This is the practical setup that meets the standard the ICO is increasingly applying:

**Dial-time list checks** against TPS / CTPS happen in your dialler. CallGuard does not replace this layer. What CallGuard does is score the call that happens after the dial.

**Per-call AI scoring** on 100% of completed calls against a PECR-aware scorecard. Caller identification, consent capture, recording disclosure, opt-out handling, no-pressure-language, vulnerable-customer indicators. Each scored with an evidence quote.

**Live mid-call breach detection** on outbound campaigns where regulator-grade events are possible. Pressure-language alert, missing-consent alert, complaint-trigger alert. Webhooks to the supervisor screen so floor managers can intervene.

**Breach register with closed-loop remediation**. Each detected breach has a severity, a status, an owner, a resolution and a date. The register answers question 5 above before it gets asked.

**Per-agent coaching memory**. Agents who triggered a breach get coaching that builds on what was said to them last time. Coaching delivery is the human layer; the coaching draft is the AI layer.

**Quarterly compliance digest**. AI-generated insights digest summarising what changed, the patterns worth attention, and the systemic actions taken. This is the strategic-level evidence the ICO would want to see if they asked about your monitoring regime.

## The cost-of-compliance maths

For an outbound team running 50,000 calls a week, the question is not "can we afford to do AI-driven monitoring" but "can we afford a single seven-figure ICO fine that better monitoring would have prevented". The 2024 ICO penalties for PECR breaches against single-firm offenders included multiple six- and seven-figure fines. The annualised cost of AI scoring on the same call volume is well below six figures.

The ROI calculation typically runs: cost of one regulator-grade breach times probability of detection times mitigation discount, compared against cost of systematic monitoring. For most outbound operations the inequality is not close.

## What we recommend for the next 90 days

Three concrete steps in order:

**Audit your current scorecard against PECR's five on-call items above.** Most outbound scorecards we see cover urgency-language and consent capture but underweight caller identification timing, recording disclosure cadence, and opt-out acknowledgement. Add scorecard items for the gaps.

**Score 200 recent outbound calls against the updated scorecard.** Whether you do this manually or via AI scoring, the goal is to find systematic patterns. The same PECR failures usually show up across many agents.

**Build a remediation plan tied to those patterns.** Update training scripts, update the dialler dispositions, add coaching memory so flagged agents get follow-up coaching. Track the trend in your scoring data so you have month-over-month evidence the regime is working.

If "score 200 recent calls" is the part that gets stuck because you do not have the QA capacity, that is the gap AI scoring closes. We run a 15-minute demo against five of your own outbound recordings. [Email hello@callguardai.co.uk](mailto:hello@callguardai.co.uk?subject=CallGuard%20AI%20%E2%80%94%20PECR%20demo) and we will set it up.

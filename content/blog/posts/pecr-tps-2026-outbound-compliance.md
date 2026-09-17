---
title: "PECR and TPS in 2026: practical compliance for outbound teams."
ogTitle: "PECR/TPS 2026 Compliance for Outbound Teams"
breadcrumb: "PECR and TPS 2026"
description: "What PECR regulation 21 actually prohibits on a live marketing call, what regulation 24 requires an agent to say, and what an outbound team can evidence."
ogDescription: "Regulation 21 is not a consent rule. What it prohibits, what regulation 24 requires, and what the recording can evidence."
cardTag: "Compliance · Outbound"
cardSummary: "Regulation 21 is not a consent rule. What it actually prohibits on a live marketing call, what regulation 24 requires the agent to say, and which of the rules on that call are not PECR at all."
order: 1
date: "2026-05-05"
updated: "2026-09-17"
time: "10:00"
section: "Compliance"
topic: "regulation"
author: "charlotte"
ctaSubject: "CallGuard%20AI%20%E2%80%94%20PECR%20demo"
useCaseLink: "/use-cases/outbound-sales"
related:
  - fca-consumer-duty-call-recordings
  - score-100-percent-contact-centre-calls
  - ai-vs-human-call-scoring
sources:
  - "The Privacy and Electronic Communications (EC Directive) Regulations 2003, regulation 21|https://www.legislation.gov.uk/uksi/2003/2426/regulation/21"
  - "The Privacy and Electronic Communications (EC Directive) Regulations 2003, regulation 21A|https://www.legislation.gov.uk/uksi/2003/2426/regulation/21A"
  - "The Privacy and Electronic Communications (EC Directive) Regulations 2003, regulation 24|https://www.legislation.gov.uk/uksi/2003/2426/regulation/24"
  - "The Privacy and Electronic Communications (EC Directive) Regulations 2003, regulation 26|https://www.legislation.gov.uk/uksi/2003/2426/regulation/26"
  - "Data (Use and Access) Act 2025 (c. 18)|https://www.legislation.gov.uk/ukpga/2025/18/introduction"
---

PECR and TPS get referenced in passing on most outbound floors and read closely on very few of them. The result is a misunderstanding so common it is built into the scorecards: the belief that a live marketing call to someone who is not already a customer requires that person's consent. Regulation 21 does not say that. It says something narrower, and a team scoring its calls against a rule that does not exist is evidencing the wrong thing. Here is what the regulations actually require of a live marketing call, and what the recording can show.

## The short version

PECR — the Privacy and Electronic Communications (EC Directive) Regulations 2003 — governs unsolicited direct marketing by electronic means. The Telephone Preference Service and its corporate equivalent, the CTPS, list the numbers whose subscribers do not want marketing calls; the register itself is kept by the Information Commissioner under [regulation 26](https://www.legislation.gov.uk/uksi/2003/2426/regulation/26). Live marketing calls sit under [regulation 21](https://www.legislation.gov.uk/uksi/2003/2426/regulation/21).

Five points, each reversing something we routinely find in an outbound QA scorecard:

1. Regulation 21 prohibits certain calls. It does not require consent for a live marketing call, and there is no general consent gate for one.
2. Consent is the gate somewhere else: regulation 19 for automated calling systems, [regulation 21A](https://www.legislation.gov.uk/uksi/2003/2426/regulation/21A) for claims management marketing, and regulation 21B for pensions.
3. "Soft opt-in" is regulation 22, and regulation 22 is about electronic mail. It has nothing to say about a live call.
4. [Regulation 24](https://www.legislation.gov.uk/uksi/2003/2426/regulation/24) requires the caller's name. An address or a freephone number is required only if the recipient asks for it.
5. Two of the things every outbound scorecard checks — recording disclosure and the in-call right to object to marketing — are not PECR at all.

## Regulation 21 prohibits a call; it does not require consent

Regulation 21 bites in two situations. A person may not use, or instigate the use of, a public electronic communications service to make unsolicited calls for direct marketing purposes where the subscriber has "previously notified the caller that such calls should not for the time being be made" on that line, or where the number is listed in the register kept under regulation 26.

Two qualifications matter operationally. A number listed on the register for less than 28 days does not put the caller in breach of the second limb, which is why dialler suppression is usually described as a 28-day obligation. And regulation 21(4) runs the other way: a subscriber whose number is on the register may notify a particular caller that they do not, for the time being, object to calls from that caller, and calls from that caller may then be made. The subscriber can withdraw that notification at any time, and once withdrawn the calls must stop.

So the regulation 21 question for a given number is not "do we hold consent". It is two narrower questions: has this subscriber told us to stop, and is this number on the register — and if it is, did the subscriber themselves tell us they do not object?

That last distinction is where marketing lists go wrong. A tick on a third party's form is not a notification to you under regulation 21(4). The exception is caller-specific by construction, and it is the subscriber's to give and to take back.

## Soft opt-in is a regulation about email

The "soft opt-in" everyone means when they use the phrase is the exception in regulation 22, and regulation 22 governs direct marketing by electronic mail. Whatever latitude it gives, it gives for email. It does not apply to a live call, and finding it cited in a call script or a call scorecard is a reliable sign the two regimes have been conflated.

## What regulation 24 requires the agent to say

Regulation 24 is short, and shorter than most scorecards assume. For a live marketing call it requires the name of the person making the call to be provided. It also requires an address, or a telephone number on which that person can be reached free of charge — but only if the recipient asks for it.

Regulation 24 says nothing about stating the purpose of the call, and it imposes no timing test. There is no rule that says identification must come before the qualification questions.

That is the regulation. Our recommendation, which is ours and not the Information Commissioner's: identify the firm and the reason for the call in the first thirty seconds anyway, and hold agents to it on the scorecard. A call that hides who is calling until the customer has confirmed their date of birth is not a regulation 24 breach, but it is the kind of call that becomes a complaint — and the complaint is decided on the recording.

## The two rules on that call that are not PECR

**Recording disclosure.** Telling the customer the call is recorded is a transparency obligation under UK GDPR Articles 13 and 14, and for the firms they apply to, under the FCA's taping rules. It is not in PECR. This matters when you write the scorecard, because the standard is "was the information given", not "was a consent obtained" — and because the obligation exists whether or not the call is a marketing call.

**The right to object during the call.** When a customer says "stop calling me" mid-call, the immediate obligation is UK GDPR Article 21(2)-(3): where personal data is processed for direct marketing, the individual has an absolute right to object, and on objection the data must no longer be processed for that purpose. PECR regulation 21 bites on the next call, not this one — the customer's words become the "previously notified" trigger that makes a later call unlawful.

The practical consequence is the same either way, and it is worth scoring: an agent who says "I understand, but before you go" has created two problems, and one of them is on a recording.

## The Data (Use and Access) Act 2025

Copy still circulating online describes this as a Bill in parliamentary process. It is not. The Data (Use and Access) Act 2025 (c. 18) received Royal Assent on 19 June 2025 and is on the statute book. If you are relying on anything in it, read the in-force text rather than the coverage of the Bill, and check the commencement position for the provision you care about.

## Where FCA-regulated outbound differs

Outbound teams selling FCA-regulated products — general insurance, pure protection, mortgages, consumer credit — have PECR underneath and the FCA's Consumer Duty on top. They are not the same test, and they do not overlap much.

PECR governs whether the call should have been made at all and what had to be said about who is calling. The Consumer Duty governs the outcome. Only two parts of it are visible in the conversation itself: PRIN 2A.5 on consumer understanding and PRIN 2A.6 on consumer support. The rest is evidenced in the file and in the product governance record, not on the recording. [We set out that split in detail in our Consumer Duty piece.](/blog/fca-consumer-duty-call-recordings)

## What an outbound scorecard can actually evidence

Dial-time checks against TPS and CTPS happen in the dialler, before the call exists. Nothing scored after the fact replaces that layer. What the recording evidences is everything that happened once the line connected:

- The caller's name was given, per regulation 24, and the firm and purpose were given early, per your own standard.
- A stop request was acknowledged and honoured, and the pitch did not continue past it.
- The customer's mention of their TPS registration got a substantive response rather than an "I see".
- The recording disclosure was made, audibly and in full.
- Pressure language, urgency framing and vulnerability signals were flagged for review.

Every one of those is a binary question with a quotable answer in the transcript, which is what makes an outbound floor scoreable at all rather than samplable. [Our outbound sales use-case page](/use-cases/outbound-sales) covers how those items are scored and what the evidence looks like.

A breach register with a severity, an owner and a resolution date is the artefact that answers "what did you do about it" — always the second question, after "did it happen".

## What to do in the next 90 days

**Audit the scorecard against the regulations rather than against custom.** Delete any criterion that asserts consent is required for a live marketing call. Add the regulation 24 name check, the stop-request check and the recording-disclosure check, and label each with the rule it comes from — PECR, UK GDPR or your own standard. Auditors read labels.

**Score 200 recent outbound calls against the corrected scorecard.** The point is not to find one bad call. It is to find whether the same failure appears across many agents, because a failure that does is a script or a training problem rather than an individual one.

**Tie the remediation to the pattern.** Update the script, update the dialler dispositions, and coach the flagged agents on what they were told last time. Then track the item month over month, so the trend is itself evidence the regime works.

If "score 200 recent calls" is the step that stalls because the QA capacity does not exist, that is the gap AI scoring closes. In a short demo we score synthetic outbound calls against a scorecard like yours. When you want to try your own recordings, we put a DPA in place first. [Email hello@callguardai.co.uk](mailto:hello@callguardai.co.uk?subject=CallGuard%20AI%20%E2%80%94%20PECR%20demo) and we will set it up.

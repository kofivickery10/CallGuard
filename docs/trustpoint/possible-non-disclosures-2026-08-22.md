# Possible non-disclosures for review — Trust Point, 22 August 2026

Fifteen reconciliation items where **the submitted application answers "no" and the
customer appears to have disclosed something on the call.** All fifteen are
currently filed `undetermined` — "we could not tell" — so none of them is on the
Data Forms screen as a finding today.

They are not findings yet. Two things have to be true for one to be real, and
only a person with the recording can settle either:

1. **The words are the customer's, not the adviser's.** Advisers read the option
   list aloud, so an extracted answer can be the checklist being recited rather
   than a disclosure. Row 10 is the clearest example of that risk.
2. **The question the answer belongs to is this one.** A bare "Yes" carries no
   subject, so it may be agreement to something asked a moment earlier.

Ordered by how strongly the wording points to the customer speaking. Confidence
is the extraction model's, not a judgement about the disclosure.

---

## Strongest — first-person, specific, high confidence

These read as the customer describing their own circumstances, in their own
words. Nothing in the phrasing looks like a recited option list.

| # | Sale | Question | Application | On the call | Conf |
|---|---|---|---|---|---|
| 1 | Danny Walters | In the last 10 years have any of these applied to you? | **No** | "Prescription medication, **I use sertraline for anxiety**" | 1.00 |
| 2 | Danny Walters | In the last year have your symptoms affected your ability to work…? | **Not affected at all** | "**It sometimes prevents me** from working or performing normal day to day activities" | 1.00 |
| 3 | Catherine Barrett | Due to illness or injury, do any of the following apply? | **None of these** | "**I'm currently off work**" | 0.85 |
| 4 | Julie Martin | Due to illness or injury, do any of the following apply? | **None of these** | "**I'm currently off work, I'm working reduced hours**" | 0.85 |
| 5 | Julie Martin | Apart from anything you've already told us about, have any of these applied…? | **No** | "**I have had or am waiting to have** test scans, investigation, counselling" | 0.85 |

Rows 1 and 2 are the same sale, and both at 1.00. Rows 3 and 4 are the same
question on two different sales, which is worth noting on its own — if two
advisers both recorded "none of these" against a customer saying they are off
work, the question may be being asked in a way that invites it.

## Strong — the customer named a company

An insurer's name is not checklist wording, so this is the customer's own answer.
Both are the same question, both answered "none of these" on the form.

| # | Sale | Question | Application | On the call | Conf |
|---|---|---|---|---|---|
| 6 | Gordon Forsythe | Is your existing life cover with any of the following companies? | **None of these** | "Sun Life" | 0.95 |
| 7 | Jason Hamilton | Is your existing life cover with any of the following companies? | **None of these** | "Smart Insurance" | 0.95 |

## Probably not a finding

| # | Sale | Question | Application | On the call | Why |
|---|---|---|---|---|---|
| 8 | Karen Cable | Do you take part in any of the following? | No | "Scuba diving (but not currently)" | The qualifier makes "no" defensible for a current-activity question |
| 9 | Gareth Stevens | Active Lifestyle Cover | No Premium details | "Yes" | A product-configuration field, not a customer disclosure |
| 10 | Julie Martin | Have your birth parents, brothers, or sisters had any of these before 65? | No | "Heart attack or stroke" | **Verbatim checklist wording** — most likely the adviser reading the list, not the customer disclosing. Check before treating as anything. |

## Cannot be judged without the recording

A bare "Yes" against a negative form answer. It means something, but nothing
here says what it was agreement to — and four of the five are on one sale whose
document was a client review rather than an application form (D-17), so the
question set itself is unreliable.

| # | Sale | Question | Application | On the call |
|---|---|---|---|---|
| 11 | Zain Isaacs | Advised sale | No | Yes |
| 12 | Amanda Chappell | Have you ever been medically advised to reduce your alcohol consumption? | No | Yes |
| 13 | Amanda Chappell | Any stomach, digestive system, bowel, liver or blood disorder? | No | Yes |
| 14 | Amanda Chappell | Are you awaiting any of the following for this condition? | None of these | Yes |
| 15 | Amanda Chappell | Which of the following apply to your osteoarthritis? | None of the above | Yes |

---

## Why these are not reported automatically

`compareAnswers` needs both sides to carry a polarity before it will compare
them, and the containment rule requires four characters, so an application
answer of "No" cannot be compared against anything. Every one of these falls
through to "could not tell".

The obvious rule — negative application answer plus a specific call answer
equals a mismatch — is what row 10 argues against. Building it without settling
these fifteen first would put false accusations on advisers' records on health
questions, which is the one thing this module is built not to do.

**So the ask is the reverse of the usual one: read these, and the answers tell us
whether the rule is safe to write.** If rows 1–7 are real disclosures and row 10
is a recital, the distinguishing signal is first-person phrasing, and that is
implementable. If it is messier than that, it stays a human review queue and we
say so.

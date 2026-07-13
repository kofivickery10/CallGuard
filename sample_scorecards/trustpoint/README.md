# Trust Point — Protection QA onboarding

Scorecard + KB mapping generated from Trust Point's supplied files (QA Framework
and Scoring Matrix June 2026.xlsx, the two Protection Wrap-Up scripts, and Sales
Process v4 — all under `docs/trustpoint/`). Status: **v2.0 — regenerated from the
authoritative 47-item QA Framework; pending Trust Point sign-off on the manual-item
split (see below).**

## Scorecards

**Use `trustpoint-protection.csv`** — a single branched scorecard, one row per
QA Framework item, covering both application outcomes. Regenerate with
`sample_scorecards/trustpoint/gen_scorecard.py` if the framework changes.

| File | Items | Notes |
|---|---|---|
| `trustpoint-protection.csv` | 47 | **Recommended.** Exactly the QA Framework's 47 items: 44 AI-scored + 3 manual (see split below), 7 consent gates, 10 word-for-word, `on_risk`/`referred` branch tags. |
| `trustpoint-protection-on-risk.csv` | 43 | Legacy per-outcome card (superseded). |
| `trustpoint-protection-referred.csv` | 41 | Legacy per-outcome card (superseded). |

### Import
Scorecards → New → Import CSV. The importer reads `label, description,
score_type, weight, severity, section, item_type, branch, expectation,
ai_check, consent_gate`. Branch names in the CSV pre-fill the branch list —
after import, set the **branch keywords** so the scorer can tell the paths apart:

- `on_risk` (default branch — leave keywords empty)
- `referred`: `referred for underwriting, referred to the underwriters, not active yet, no final decision, hasn't declined`

### What the columns drive
- **severity** — drives the breach register (critical/high fails raise breaches).
- **section** — the QA Framework category; groups items in dashboards/coaching.
- **item_type=manual** — never sent to the AI; lands in the review queue,
  excluded from the AI-scored denominator (see the split below).
- **branch** — outcome-specific items score only on their branch; on the other
  branch they resolve to `na` and drop out of the denominator. `on_risk`: the
  Direct Debit setup and the two Policy-in-Trust items. `referred`: the "not
  active yet" Direct Debit item.
- **consent_gate=true** — the 7 hard-consent items require an explicit customer
  "yes"; low-confidence speaker attribution routes them to manual review.
- **ai_check** — set on the 10 word-for-word regulatory statements to require
  presence *and* full regulatory meaning.

## ⚠️ Open item: the 9 "Manual Process" items (Trust Point sign-off)

The framework splits the 47 items **38 AI (80.94%) + 9 Manual (19.08%)** but the
spreadsheet does not tag *which* 9. Three are unambiguous back-office checks and
are shipped as `manual` (items 7, 8, 25 — fact find on CRM, recommendation on
file, disclosure-entry accuracy).

**The scorecard leaves the other 44 as AI by design** — better to over-score than
to silently suppress a compliance checkpoint. To reach the framework's 9-manual
figure, Trust Point should confirm **6 more** to flip to `item_type=manual`.
Recommended set, with rationale (these are quality/process checks that a call
recording alone can't fully evidence):

| Item | Why it may be manual |
|---|---|
| 24 — allowed customer to answer every H&L question | Quality check against how the application was actually completed |
| 26 — did NOT lead the customer's H&L answers | Integrity check; hard to evidence conclusively from audio |
| 43 — explained placing the policy in Trust | Trust set-up is a back-office follow-up, on_risk only |
| 44 — arranged to contact the nominated trustee | Admin action tracked off-call |
| 45 — raised will / estate planning | Follow-up booked off-call |
| 16 — summarised risks & confirmed agreement, **or** 19 — features vs file | Either the needs-summary quality or the features-vs-file accuracy check |

Once confirmed, edit those rows' `item_type` to `manual` and re-import (or flip
them in the Scorecard Editor). Nothing is lost either way — manual items stay on
the card and appear in the review queue.

## Knowledge Base

Ready-to-upload KB content built from the source docs lives in
[`docs/trustpoint/kb/`](../../docs/trustpoint/kb/) — see the README there for the
file → section mapping (company overview, compliance rules, and the three
scripts). Also set Organisation Settings → **Industry / advice domain** to
`FCA-regulated protection insurance advice (life, critical illness, income
protection)`, and configure CloudTalk / Zoho under Integrations so journeys
assemble per sale.

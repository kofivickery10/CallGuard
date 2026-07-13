# Trust Point — Protection QA onboarding

Draft scorecards + KB mapping derived from Trust Point's supplied files
(QA Framework and Scoring Matrix June 2026.xlsx, the two Protection Wrap-Up
scripts, and Sales Process v4). Status: **v1.0 draft — pending Trust Point
sign-off on the manual-item split (see below).**

## Scorecards

**Use `trustpoint-protection.csv`** — a single branched scorecard covering both
application outcomes. CallGuard now supports branch-scoped criteria with an N/A
result, so the previous two-scorecard split is no longer needed:

| File | Items | Notes |
|---|---|---|
| `trustpoint-protection.csv` | 49 | **Recommended.** 38 common + 5 `on_risk` + 3 `referred` branch items + 3 manual back-office items. |
| `trustpoint-protection-on-risk.csv` | 43 | Legacy per-outcome card (kept for reference). |
| `trustpoint-protection-referred.csv` | 41 | Legacy per-outcome card (kept for reference). |

### Import
Scorecards → New → Import CSV. The importer reads `label, description,
score_type, weight, severity, section, item_type, branch, expectation,
ai_check, consent_gate`. Branch names found in the CSV pre-fill the scorecard's
branch list — after import, set the **branch keywords** so the scorer can tell
the paths apart. Suggested:

- `on_risk` (default branch — leave keywords empty)
- `referred`: `referred for underwriting, referred to the underwriters, not active yet, no final decision`

### What the columns drive
- **severity** — now imported directly; drives the breach register (critical/high
  fails raise breaches).
- **section** — groups items in dashboards and coaching views.
- **item_type=manual** — the three back-office items (fact find on CRM, suitability
  review, data-entry accuracy) are included as `manual`: never sent to the AI,
  land in the review queue, excluded from the AI-scored denominator.
- **branch** — outcome-specific items score only on their branch; on the other
  branch they resolve to `na` and drop out of the denominator.
- **consent_gate=true** — the six hard-consent items require an explicit customer
  "yes"; if speaker attribution on the evidence is low-confidence the item routes
  to manual review instead of a score.
- **ai_check** — set on the word-for-word regulatory statements (FCA authorisation,
  advised/no-fee, call recording, honesty warning, exclusions/cancellation) to
  require presence *and* full regulatory meaning.

## ⚠️ Open item: the 9 "Manual Process" items
Trust Point's matrix splits the 47 items into **38 AI-scored (80.94%) + 9 Manual
Process (19.08%)** but the spreadsheet does **not** tag which rows are manual.
Only three unambiguous back-office rows are included as `manual` items:
- **7** — full Fact Find completed & recorded on the CRM
- **8** — comprehensive, justified recommendation (file/suitability review)
- **25** — all customer disclosures input accurately (data-entry accuracy)

That leaves 44 call-observable AI items, i.e. **6 more than Trust Point's "38
AI" count.** Trust Point needs to confirm which 6 further items they treat as
manual so they can be flipped to `item_type=manual` (not deleted — manual items
now stay on the card). Likely candidates to query: 11 (Trust set up free of
charge), 21/23 (GP-report admin), 16 (risk summary vs file), 19 (features vs
file).

## Knowledge Base staging
Upload the supplied docs to Knowledge Base sections so the scorer has Trust
Point's expected call flow as context (it's injected into the scoring prompt):

| Document | KB section |
|---|---|
| Trust Point – Sales Process v4 | **Sales Scripts** (`scripts`) |
| Protection Wrap Up Script – On Risk | **Sales Scripts** (`scripts`) |
| Protection Wrap Up Script – Referred | **Sales Scripts** (`scripts`) |
| Regulatory "word-for-word" statements (from the framework) | **Compliance Rules** (`compliance`) |

Also set Organisation Settings → **Industry / advice domain** to
`FCA-regulated protection insurance advice (life, critical illness, income
protection)` so calls are scored in the right regulatory context, and (if calls
arrive via CloudTalk or Zoho sale triggers) configure those under
Integrations so journeys assemble automatically per sale.

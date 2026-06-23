# Trust Point — Protection QA onboarding

Draft scorecards + KB mapping derived from Trust Point's supplied files
(QA Framework and Scoring Matrix June 2026.xlsx, the two Protection Wrap-Up
scripts, and Sales Process v4). Status: **v0.9 draft — pending Trust Point
sign-off on the manual-item split (see below).**

## Scorecards

Two scorecards, one per application outcome, because CallGuard scores every
listed item and has no "not applicable" state yet — so path-specific items would
otherwise fail on the wrong call type. Pick the scorecard per call (Calls →
scorecard selection).

| File | Items | Use for |
|---|---|---|
| `trustpoint-protection-on-risk.csv` | 43 | Calls where the policy goes **on risk** (accepted / immediate acceptance). Mirrors *Protection Wrap Up Script – On Risk*. |
| `trustpoint-protection-referred.csv` | 41 | Calls **referred for underwriting**. Mirrors *Protection Wrap Up Script – Referred*. |

38 items are common to both. On Risk adds DD/start-date (35), Trust (43, 44) and
accepted-terms outcome (30, 31). Referred adds the referred DD script (36) and
the "not active yet" outcome wording (30, 31).

### Import
Scorecards → New → paste/upload CSV. The importer reads `label, description,
score_type, weight`. All items are `binary`, `weight 1` (Trust Point weights
items roughly equally — ~2.13% each — so equal weighting reproduces the same
relative result).

### Severity (the 5th column)
The CSV includes a `severity` column for documentation, but **the current CSV
importer ignores it** — severity is set per item in the Scorecard Editor after
import (it drives the breach register). Proposed mapping:
- **critical** — hard-consent gates (info-sharing yes, recommendation yes, happy
  with cover/premium yes), the honesty/non-disclosure warning, and not leading
  the customer in Health & Lifestyle answers, and the Referred "not active yet".
- **high** — regulatory disclosures (FCA authorisation, advised/no-fee, call
  recording, data sharing, vulnerability, key features, GP consent, cancellation
  rights, document consent) and the DD/outcome items.
- **medium** — process/recap items.
- **low** — rapport, future support, Google review, referral, estate planning.

## ⚠️ Open item: the 9 "Manual Process" items
Trust Point's matrix splits the 47 items into **38 AI-scored (80.94%) + 9 Manual
Process (19.08%)** but the spreadsheet does **not** tag which rows are manual.
Only three are unambiguously back-office and have been **excluded** here:
- **7** — full Fact Find completed & recorded on the CRM
- **8** — comprehensive, justified recommendation (file/suitability review)
- **25** — all customer disclosures input accurately (data-entry accuracy)

That leaves these drafts at 44 call-observable items, i.e. **6 more than Trust
Point's "38 AI" count.** Trust Point needs to confirm which 6 further items they
treat as manual so they can be removed. Likely candidates to query: 11 (Trust set
up free of charge), 21/23 (GP-report admin), 16 (risk summary vs file), 19
(features vs file). Once confirmed, regenerate via
`scratchpad/gen_scorecards.py`.

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
protection)` so calls are scored in the right regulatory context.

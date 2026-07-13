# Trust Point — Knowledge Base upload map

These files are the Knowledge Base content for the Trust Point tenant, built
from their supplied source docs (Sales Process v4, the two Protection Wrap-Up
scripts, and the QA Framework & Scoring Matrix, June 2026). The scorer injects
KB content as context, so uploading these makes the AI judge calls against Trust
Point's actual expected flow and word-for-word statements.

Upload each file to the matching Knowledge Base section (Settings → Knowledge
Base):

| File | KB section |
|---|---|
| `company-overview.md` | **Company overview** (`company_overview`) |
| `compliance-rules.md` | **Compliance rules** (`compliance`) |
| `sales-process-v4.md` | **Sales scripts** (`scripts`) |
| `wrap-up-on-risk.md` | **Sales scripts** (`scripts`) |
| `wrap-up-referred.md` | **Sales scripts** (`scripts`) |

Also set Organisation Settings → **Industry / advice domain** to:
`FCA-regulated protection insurance advice (life, critical illness, income protection)`

Source of truth: `docs/trustpoint/*.docx` / `*.xlsx`. If Trust Point revise a
script, re-derive these from the new source rather than editing in place.

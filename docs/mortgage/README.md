# Mortgage advice — onboarding template

A sector template for onboarding a **UK regulated residential mortgage advice**
firm. Unlike `docs/trustpoint/`, nothing here is tenant-specific: it is the
starting point you copy and adapt per firm.

## What's in it

| File | Purpose |
|---|---|
| `../../sample_scorecards/mortgage/mcob-mortgage-advice.csv` | 34-checkpoint scorecard: MCOB 4 disclosure and suitability, MCOB 11 affordability and interest-only, MCOB 12 charges, FG21/1 vulnerability, Consumer Duty |
| `kb/compliance-rules.md` | The MCOB baseline the scorer judges against. Firm-agnostic — usable as-is |
| `kb/products.md` | Product types, terminology and common 8kHz mishearings |
| `kb/company-overview.md` | **Template with placeholders** — must be edited per firm |
| `../../packages/api/src/scripts/onboard/mortgage-advice.example.json` | Onboarding config |

## Onboarding a firm

1. Copy `mortgage-advice.example.json` to `<firm>.json` and replace every
   `CHANGE_ME`.
2. Copy `kb/company-overview.md` to a firm-specific copy and fill in every
   `[BRACKETED]` value — scope of service, fee position, FRN, adviser names.
   **An unedited overview produces wrong breaches**, because the scorer treats it
   as fact and will fail scope and fee items on every call.
3. Dry run, which writes nothing:
   ```bash
   npm run onboard-tenant --workspace=packages/api -- --config src/scripts/onboard/<firm>.json --dry-run
   ```
4. Run it for real, then send the printed temporary password over a secure
   channel.

## Decisions worth making per firm

**Journey window.** The config sets `journey_window_days: 120`. A mortgage case
runs fact find → recommendation → offer → completion over weeks or months, and
the platform default of 30 days would drop the early calls — the ones carrying
almost every suitability and disclosure checkpoint — from the scored case. Raise
it for new-build business, which can run six months or more.

**Scoring scope.** `sales_only` scores a completed case as one compliance unit
once a sale trigger fires. That needs a trigger: a CRM webhook, or advisers using
the manual "this call is a sale" flag. With neither, use `everything` so calls are
scored individually rather than waiting forever for a trigger that never comes.

**Off-the-phone advice.** Teams, Zoom and Meet recordings can be uploaded
directly — the audio is extracted on ingest and only the audio is stored
(`services/media.ts`). They are mono mixes, so leave `transcription_mode` as
`mono_diarize`.

**Branching.** The template is unbranched. If a firm wants purchase, remortgage
and product-transfer cases judged against different checkpoint sets, add a
`branch_config` and a `branch` column to the CSV — see `onboard/trustpoint.json`
for a worked example.

## Not covered

- **Equity release, lifetime mortgages, later-life lending.** MCOB 8 adds
  requirements this scorecard does not test (mandatory advice, rolled-up interest
  and its effect on the estate, means-tested benefits, family involvement). These
  need their own scorecard with manual-review gates.
- **Buy-to-let.** Consumer BTL is regulated; most business BTL is not. Establish
  which applies before scoring BTL calls against this.
- **File-review obligations.** Whether the ESIS was issued in time, whether the
  suitability letter matches the advice, and whether the lender's affordability
  assessment was completed correctly cannot be judged from a recording. They are
  deliberately absent from the scorecard rather than present as items the AI would
  guess at.

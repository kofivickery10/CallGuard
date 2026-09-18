# Service Box — New Business QA card (demo draft)

Built from Service Box's **Call Monitoring Guidelines - New Business.xlsb**
(received 14 September 2026) for the demo on Friday 18 September 2026, then
revised on 16 September against their September 2026 appliance script and three
of their own sale recordings (see "Test run on their calls"). It is still a
**draft**: six of their seven product scripts have not arrived, and a few
readings of their sheet still need confirming with them (listed at the end).

| File | What it is |
|---|---|
| `servicebox-new-business.csv` | The card, ready to import: 17 checks, 1 of them manual. |
| `kb-scripts.md` | Their September 2026 appliance script, for Knowledge Base → Scripts. |
| `gen_scorecard.py` | Generates the CSV. Edit this, not the CSV, then run `python3 gen_scorecard.py`. |

## How their sheet maps onto the card

Their sheet has 11 elements. Seven are auto-fail at 11% each, four are soft at
5.75% each, and the pass mark is 90%. The weight column can't hold 11 (it tops
out at 9.99), so the card keeps the same ratio on a smaller scale: soft 0.69,
auto-fail 1.32, card total 12.00.

| Their element | Auto-fail | Checks on the card | Weight each |
|---|---|---|---|
| Introduction | No | 1 | 0.69 |
| Benefit & Replacement Terms | No | 1 | 0.69 |
| Duration & Costs | Yes | 2: duration and costs; first payment date | 0.66 |
| Exclusions | Yes | 1 (contribution level on the 4 plans that have one) | 1.32 |
| Good Working Order | Yes | 1 (consent gate) | 1.32 |
| Mandatory Confirmation | Yes | 2 (consent gates): not covered elsewhere and domestic use; outside the manufacturer's warranty | 0.66 |
| DD Guarantee & Cancellation Period | No | 1 | 0.69 |
| Plan Set Up & Commitments | Yes | 2: email and post (AI); plan set up correctly (**manual**) | 0.66 |
| Agent Conduct | No | 1 | 0.69 |
| True & Factual | Yes | 3: factual; answered questions; vulnerability | 0.44 |
| Final Statement | Yes | 2: "discretionary, not insurance" statement; customer happy | 0.66 |

- **Auto-fail elements are split into separate acts.** Every part is
  `critical`, so missing any part fails the call, just as missing the element
  does on their sheet. Compound checks were the biggest source of unstable
  verdicts on Trust Point's card; splitting them gives steadier scoring and
  tells the agent exactly what was missed.
- **Soft elements are not split.** On their sheet a soft element is all or
  nothing: one soft miss passes (94.25%) and two fail (88.5%). Splitting one
  would let a partial miss cost less and could turn a fail into a pass.
- **Product differences live in each check's `expectation`.** The sheet words
  each element separately for 7 products. The scorer works out the product
  from the call and applies the right rule. There are no branches, deliberately
  (see below).

### Checked against their rule

Every combination of element outcomes, and every combination of missed parts
within a split element (81,920 cases, standard and Additional Cover), was
scored through the real `callPasses`. This was run on the 16-check card, before
Mandatory Confirmation was split in two; it has not been re-run since. Both new
parts are `critical`, so the pass/fail logic is unchanged, but the percentages
below come from the earlier card.

- **Pass/fail matches their sheet in every case** once the manual check has
  been ruled on.
- **While the manual check waits for review**, a call whose only miss is that
  check shows as a pass until someone rules it a fail (10 cases, all of that
  kind).
- **The percentage can differ from the sheet on a call that has already
  failed**, e.g. one True & Factual part missed shows 96.33% FAIL where the
  sheet would show 89% FAIL. It also differs on Additional Cover calls (one
  soft miss: 94.25% here, 92.63% on the sheet), because of how those two N/A
  checks are handled. Pass/fail is the same.

## Why there are no branches

Additional Cover Appliances is the only product where elements don't apply
(Good Working Order, Mandatory Confirmation). Their sheet points that product
at a separate "Additional Cover Protection Plan" script. Adding appliances to an
existing plan, upgrading, downgrading or restarting a plan is sold on the "New
Business Appliance Protection Plans" script, so the card treats those as
Appliance sales, where both elements apply in full. Branches would score those as
N/A properly, but `score-prospect-calls.ts` never sets a branch config. With no
branch config, a branch-tagged check is N/A on **every** call, which would
silently remove two auto-fail checks from the whole demo. Instead, those two
checks tell the scorer to mark them met on an Additional Cover call and say
why. For production, the better fix is routing each GreenLight campaign to its
own product scorecard at ingest.

## Loading it

### Option A — score their own recordings (best demo)

The run creates a throwaway `PROSPECT –` org with 14-day retention, admin login,
card, settings and knowledge base, then queues each recording through the normal
pipeline. **Run it on the production host.** Audio is stored on the server's own
disk and jobs go to the server's Redis, so a run from a laptop pointed at the
production database creates the org, but the production worker never sees the
calls. Preview first (no writes), then add `--yes`:

```bash
cd packages/api
npx tsx src/scripts/score-prospect-calls.ts --dir /path/to/servicebox-recordings \
  --org-name "Service Box" \
  --scorecard ../../sample_scorecards/servicebox/servicebox-new-business.csv \
  --industry "home appliance, boiler and heating protection plan sales (discretionary plans, not insurance)" \
  --pass-threshold 90 \
  --transcription-mode stereo_multichannel --adviser-channel 1 \
  --kb-scripts ../../sample_scorecards/servicebox/kb-scripts.md \
  --keyterms "Service Box,cooling off period,discretionary,not insurance,Direct Debit guarantee,good working order,manufacturer's warranty,domestic purposes only,tumble dryer,fridge freezer,washing machine,Trustpilot"
```

- `--pass-threshold 90` is their pass mark; the org default is 70.
- Their sample recordings are genuine split stereo (8 kHz MP3), with the agent
  on the right channel, so `--transcription-mode stereo_multichannel
  --adviser-channel 1` gives exact Agent/Customer labels. Check new files with
  `scripts/probe-audio.sh` first. For mono files, use `--mono-first-speaker
  customer` instead: on their outbound dialler the customer answers first.
- `--kb-scripts` loads the script into Knowledge Base → Scripts.
- `--keyterms` helps Deepgram hear their vocabulary: before it was set,
  "cooling off period" came out as "calling off period".
- All of these are applied before any call is ingested.

When the demo is over, run the teardown command the script prints.

### Option B — import into an existing demo tenant

1. In the app, go to Scorecards → New → Import CSV and choose
   `servicebox-new-business.csv`.
2. Set the pass mark to 90 on the tenant's admin page. This applies to the
   whole org.

The first-speaker setting isn't on the admin page; set it in the onboarding
config or the database.

### Knowledge base

Several checks judge against "the script for the product being sold".
`kb-scripts.md` holds the one script received so far, the September 2026
Standard/Dynamic Pricing appliance script, transcribed from their PDF. Text shown
in red in the PDF is in capitals. Load it into **Knowledge Base → Scripts** (Option A does this).
The other six product scripts are still owed; until they are added, checks on
those products rely on the card's own wording, which is looser.

## Test run on their calls (16 September 2026)

Service Box sent three appliance sale recordings, and they were scored end to
end, first locally and then on a production prospect tenant. All three fail
their 90% pass mark, each on auto-fail requirements the transcript shows
plainly: a missing total cost, a missing "discretionary, not insurance"
statement, the manufacturer's warranty left out of the mandatory confirmation, a
sale carried on past clear signs of vulnerability, and, on every call, no "are
you happy with everything I've mentioned today?".

The first run also produced wrong verdicts that came from the card, not the
agent. Each was fixed in `gen_scorecard.py`:

| Wrong verdict | Cause | Change |
|---|---|---|
| First payment date "vague" | Deepgram replaces dates with `[DATE_1]` | Checks that turn on dates, amounts or account digits say a tag means the value was stated |
| Documents by post marked a fail | Customer had no email | Post counts as customer led when the customer has no email or can't use it |
| Data protection failed without a full name | Card read the script literally | Two pieces of identifying information, as their sheet says |
| Cancellation period missed | "cooling off" transcribed as "calling off" | Noted in the check; keyterms added |
| Exclusions failed for leaving out accidental damage | Dynamic pricing covers it | Either pricing passes; don't fail for the pricing not being named |
| Questions marked unanswered on a garbled line | No rule for unclear transcript | Fail only on a quotable ignored question |
| Warranty omission passed | One check covered three confirmations | Mandatory Confirmation split into two checks |

Still open after the final re-score:

- On one call, Introduction failed although the scorer's own reasoning says it
  meets the check, and vulnerability was flagged from misheard lines. Both were
  left for a reviewer to correct in the app; neither changes the call's result.
- Good Working Order fails on all three calls, because appliances added during
  the call were never checked mid-sale; only the ones already covered were.
  That is a defensible reading of "all items to be protected", but it needs
  confirming with them.

## To confirm with Service Box

1. The trading name the agent should give in the introduction (the card says
   "Service Box").
2. That two pieces of identifying information (e.g. first line of address and
   postcode) pass data protection, even though the script also asks for a full
   name.
3. Whether a one-off Boiler or Heat Pump service paid in full on the call has
   no Direct Debit. The card assumes so, and needs only the 14-day
   cancellation period for those sales.
4. Whether any of the payment step is muted in the recording (PCI). On the
   three sample calls it was not: the account-ending check is audible and
   comes through as a redacted tag.
5. The exact wording of the "discretionary, not insurance" statement, and
   their vulnerability protocol.
6. Whether "outside the manufacturer's warranty" applies to every Appliance
   plan. Their sheet says "where appropriate"; the September script makes it
   mandatory, and the card follows the script.
7. Who checks plan set-up in GreenLight today. That check is manual on this
   card; comparing the call with the plan record is the automated alternative.
8. Whether an earlier "is everything still working?" about appliances already
   covered counts as the first Good Working Order confirmation when more
   appliances are added on the call.
9. What "Additional Cover Appliances" is, and whether adding appliances to an
   existing plan is scored as that product (Good Working Order and Mandatory
   Confirmation N/A) or as an Appliance sale, which is what the card does.

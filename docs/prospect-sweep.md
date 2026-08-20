# FCA Register sweep — recurring prospect monitoring

`enrich-prospects-fca.ts --sweep` is the recurring sibling of `--discover`. Where
`--discover` builds a one-off prospect list from whatever the Register says
right now, `--sweep` remembers what it said last time and reports what
**changed** — most importantly, a firm that was an Appointed Representative and
is now directly Authorised, which is the single strongest buying signal this
tool can surface (see `migrations/104_fca_register_observations.sql` for the
full reasoning).

## What it does, each run

For every search term:

1. Page through **every** result the Register returns for that term (not just
   the first page — `--sweep` never stops early for a broad term the way
   `--discover`'s `--limit` does).
2. Skip any result that looks like a named individual entirely — no
   observation, no prospect (same `isLikelyCompanyName` heuristic and the same
   reasoning as `prospects` itself: this is firm-level data only, see
   migration 102).
3. Record every remaining result to `fca_register_observations`, including
   firms that are **excluded** from targeting (dead, introducer AR,
   CBTL/"Registered", run-off) — that's what makes the comparison possible at
   all on the next run.
4. Compare against what was already stored for that FRN:
   - **new** — never seen this FRN before.
   - **unchanged** — same status as last time. Nothing further happens beyond
     bumping `last_seen_at` — no enrichment, no prospect write. This is the
     entire cost saving a repeat sweep exists to realise.
   - **status-changed** — the Register's status for this FRN differs from
     what was stored. Worth a closer look.
5. Only new-or-changed firms get the expensive treatment: full enrichment
   (Firm/Permissions/Address lookups), the existing exclusions (dead,
   introducer, CBTL/Registered, run-off, existing CallGuard tenant), and — if
   they clear all of that — an upsert into `prospects`, with `target_tier`
   recomputed (see `migrations/105_prospect_tier.sql`).
6. Ends with a digest ordered by what needs action first: confirmed
   transitions, new firms grouped by tier, then firms that have left the
   market.

`ctps_screened_at` and `fit_score` are never touched, exactly as `--discover`
never touches them.

## Usage

```bash
# Preview only — nothing written:
npx tsx src/scripts/enrich-prospects-fca.ts --sweep "mortgage and protection" "life insurance"

# For real:
npx tsx src/scripts/enrich-prospects-fca.ts --sweep --terms-file terms.txt --yes

# --limit bounds how many new-or-changed firms get ENRICHED this run (the
# expensive Firm/Permissions/Address calls) — it never stops a term's paging
# early, so every result is still observed. Useful for a bounded manual/test
# run; leave it off for a real scheduled sweep so every genuine change gets
# enriched the same run it's detected.
npx tsx src/scripts/enrich-prospects-fca.ts --sweep --terms-file terms.txt --limit 50 --yes

# --verbose restores per-firm detail (create/update lines, full firm names
# within each tier) that the default digest deliberately keeps terse.
npx tsx src/scripts/enrich-prospects-fca.ts --sweep --terms-file terms.txt --verbose --yes
```

`--include-clients` and `--dry-run` behave exactly as they do for `--discover`.

## Recommended term set

Register search terms are constrained the same way `--discover`'s header
comment documents: **two-word phrases only**. A single common word (e.g.
"mortgage", "insurance", "advice", "financial") reliably fails outright —
either an HTTP 500 Apex governor-limit error ("Too many query rows: 50001") or
an HTTP 200 body `{Status:"413", Message:"Error: Request Entity Too Large"}` —
even on page 1, before any pagination happens.

Every candidate term below was measured against the live Register — one
search request each, reading `ResultInfo.total_count`. Use the full list; it
is the widest coverage the free API can reach.

```
mortgage solutions
mortgage advice
independent mortgage
financial advice
mortgage centre
mortgage and protection
mortgage broker
mortgage bureau
mortgage finance
property finance
equity release
mortgage company
mortgage brokers
mortgage shop
mortgage consultants
private finance
mortgage direct
home loans
mortgage choice
protection services
protection solutions
later life
mortgage network
mortgage matters
mortgage group
mortgage partners
mortgage hub
mortgage experts
protection advice
income protection
critical illness
family protection
```

### Measured coverage

| Term | Firms matched |
|---|---|
| `mortgage solutions` | 1,980 |
| `mortgage advice` | 947 |
| `independent mortgage` | 697 |
| `financial advice` | 694 |
| `mortgage centre` | 682 |
| `mortgage and protection` | 564 |
| `mortgage broker` | 506 |
| `mortgage bureau` | 483 |
| `mortgage finance` | 442 |
| `property finance` | 392 |
| `equity release` | 363 |
| `mortgage company` | 334 |
| `mortgage brokers` | 332 |
| `mortgage shop` | 298 |
| `mortgage consultants` | 273 |
| `private finance` | 270 |
| `mortgage direct` | 258 |
| `home loans` | 254 |
| `mortgage choice` | 208 |
| `protection services` | 126 |
| `protection solutions` | 106 |
| `later life` | 104 |
| `mortgage network` | 87 |
| `mortgage matters` | 87 |
| `mortgage group` | 85 |
| `mortgage partners` | 67 |
| `mortgage hub` | 38 |
| `mortgage experts` | 37 |
| `protection advice` | 33 |
| `income protection` | 21 |
| `critical illness` | 9 |
| `family protection` | 9 |

Refused with `413 Request Entity Too Large` (too generic to query):

`mortgage services`, `insurance brokers`, `insurance services`, `financial solutions`, `financial services`, `financial planning`, `wealth management`

Those 32 terms match **10,786 firm records** between them. Expect heavy
overlap (a firm called "X Mortgage Solutions Ltd" matches several) and, on
prior runs, roughly two thirds excluded as dead firms, lapsed ARs or named
individuals — so the realistic yield is a few thousand live firms, not ten
thousand.

### The coverage ceiling is real

The seven refused terms are the most generic ones, and that is not a
coincidence: the more firms a phrase matches, the likelier the Register
refuses to answer at all. So a firm named plainly `Smith Financial Services
Ltd` is **unreachable by name search** unless its name also contains a
mortgage- or protection-flavoured word.

This bias happens to work in our favour. The terms that succeed are the ones
that describe the business — a firm calling itself a mortgage or protection
broker is the target; a generic `Financial Services` firm is as likely to be
a pensions IFA. But it does mean this list is not, and cannot be, a complete
census of UK mortgage intermediaries. Completeness needs the paid Register
Extract Service (about £6.3k one-off), which also solves permission
filtering the API cannot do.

Two caveats worth knowing before adding more terms to that list:

- **`"mortgage and protection"` and `"mortgage protection"` return the
  identical set of results** — the Register silently strips the word "and"
  from a search query, so these two phrases are the same search as far as the
  API is concerned. Only one of them is worth a slot in the term list; the
  other is a wasted request every run.
- **`"protection advice"` and `"life insurance"` mostly surface product
  manufacturers, not intermediaries** — Aviva, Zurich, Standard Life and
  similar underwriters show up in these searches far more than the small
  mortgage/protection advice firms CallGuard actually wants to reach. They're
  not useless (some genuine intermediaries still surface), but expect a lower
  hit rate and more exclusions than a term like "mortgage advice" or "mortgage
  and protection".

## Cost: expensive first, cheap after

The FCA Register API allows 50 requests / 10 seconds; this script throttles to
35 to stay comfortably under that. Search pages cost one request each
regardless of outcome; enrichment (Firm + Permissions + Address) costs up to 3
more requests per new-or-changed firm.

**The first sweep against a term is expensive** — every firm it finds is "new"
by definition, since `fca_register_observations` starts empty, so every one of
them gets fully enriched. For a term like "mortgage and protection" that can
mean several hundred enrichment calls in one run.

**Every sweep after that is cheap**, because only firms that are new or whose
status has changed since the last run get enriched — everything else is a
single lightweight `last_seen_at` bump. In practice, once the register has
been swept once, a repeat run over the same terms enriches a small handful of
firms rather than hundreds.

## Recommended cron

Run weekly — an FCA status change happening this month and being caught next
week rather than in two years is the entire point; there's no need to sweep
daily.

Substitute your own checkout path below — on the current host the repo lives at
`/home/ubuntu/CallGuard`, not `/opt/callguard`.

```cron
PATH=/usr/local/bin:/usr/bin:/bin

0 6 * * 1  cd /home/ubuntu/CallGuard/packages/api && npx tsx src/scripts/enrich-prospects-fca.ts \
  --sweep --terms-file /home/ubuntu/CallGuard/prospect-sweep-terms.txt --yes \
  >> /home/ubuntu/callguard-prospect-sweep.log 2>&1
```

**No credentials in the crontab.** `config.ts` loads the repo-root `.env` on
import, which populates `DATABASE_URL`, `FCA_API_EMAIL` and `FCA_API_KEY`
before the script reads them. Repeating them in the cron line only creates a
second copy to keep in step.

**Set `PATH`, and test the exact line by hand before trusting it.** cron runs
with a near-empty environment, so a bare `npx` frequently resolves under an
interactive shell and not under cron — the job then fails immediately, writes a
short error to its log, and nothing reports it. That is precisely how this
project's nightly backup silently produced nothing for an extended period (see
`docs/backup-and-restore.md`). Find the real path with `which npx` and, if it
sits outside the `PATH` above, use the absolute path instead. Then run the
command exactly as written, as the user cron will run it, and confirm it
reaches the digest.

Because a sweep is long, also check the log has a *recent* digest rather than
assuming a silent log means success:

```bash
tail -40 /home/ubuntu/callguard-prospect-sweep.log
```

Keep the term list in its own file (one term per line, `#` for comments —
`--terms-file` supports both) rather than inline in the crontab, so it can be
extended without editing the schedule. A starter file:

```bash
cat > /home/ubuntu/CallGuard/prospect-sweep-terms.txt <<'EOF'
# Two-word phrases only — single common words fail with a governor limit.
# "mortgage and protection" and "mortgage protection" are the SAME query.
mortgage and protection
mortgage advice
mortgage broker
mortgage solutions
equity release
independent financial
# Noisier — surfaces manufacturers (Aviva, Zurich) rather than intermediaries:
protection advice
EOF
```

## Caveats

- **An AR lapse in "Firms that left the market" is a lead indicator, not just
  an exit — read it as "worth a manual look", not "worth deleting".** The
  FCA does not change a firm's status in place when it goes directly
  authorised; it issues a **new** FRN (see migration 103's own Trust Point and
  M6 Mortgage Advice examples — the AR-era and Authorised-era records are two
  different FRNs entirely for the same firm). So the digest's "Transitions
  detected" section — which fires on a single FRN's own stored status
  literally moving from the Register's exact "Appointed representative" to
  "Authorised" — is the mechanically weaker of the two ways a real transition
  gets caught, and will rarely fire in practice.

  What actually happens when a firm goes direct is that its AR-era FRN moves
  to a status like "No longer registered as an Appointed Representative" —
  which, from the observation table's point of view, looks identical to any
  other firm leaving the market (revoked, cancelled, run-off), because
  `isDeadStatus` catches all of them the same way, and lands in "Firms that
  left the market" in the digest. **That is exactly wrong to read as "this
  firm has gone away".** One of two things happened: it genuinely closed, or
  it went directly authorised under a fresh FRN — the Trust Point pattern,
  visible the moment it occurs rather than a year later. Whoever reads that
  section should treat every AR-lapse entry (as opposed to a lapse from
  "Authorised", "Registered"/CBTL, or any other non-AR status) as a prompt to
  search the firm's name on the Register by hand and look for a same-name
  sibling FRN now showing "Authorised" with a matching Companies House
  number — exactly the check `findTransitionEvidence` already does
  automatically. If that sibling FRN turns up in the SAME sweep's search
  results (which it generally will, since the firm's name is unchanged), it's
  enriched and written as a `target_tier = 'transition'` prospect
  automatically, appearing under "New firms, grouped by tier" rather than
  "Transitions detected" — so check the `transition` tier group there too,
  not only the money list.

  A cheap automated version of that manual look is plausible and not yet
  built: on an AR lapse, immediately search that firm's name and fetch the
  Companies House number of any live-looking match, the same lookup
  `findTransitionEvidence` does today, just triggered by the lapse itself
  rather than waiting for the successor FRN to surface in the same run's
  search results. Cost is small and scoped to genuine AR lapses only — a
  handful per sweep in practice, not hundreds — at roughly 2–6 extra Register
  requests per lapse (one Search, plus one Firm lookup per plausible name
  match). Worth doing if AR lapses turn out to need chasing down by hand
  often enough to be a real burden; not built in this pass.

- `--limit` bounds enrichment, not observation, and is self-healing. A term's
  full result set is always paged through and every result observed; `--limit`
  only bounds how many new-or-changed firms get the expensive Firm/
  Permissions/Address treatment in one run. If a firm's status genuinely
  changed but it was skipped purely because the budget ran out, its
  `fca_status`/`previous_status`/`status_changed_at` are deliberately left
  untouched (only `last_seen_at` and `firm_name` are bumped) — so the next
  run's diff sees the exact same change again and retries it, reported in the
  digest as "Changed/new but NOT enriched — budget reached, will retry next
  run". Nothing is silently lost; a low `--limit` on a real scheduled sweep
  just means changes queue up and clear over more runs rather than one.
- A firm's `target_tier` and every other Register-derived column on
  `prospects` is a snapshot from the last time it was enriched, not a live
  value — it can go stale between sweeps like any other field this script
  writes.

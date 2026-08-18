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

A starting term set for CallGuard's ICP (mortgage/protection intermediaries):

```
mortgage advice
mortgage broker
mortgage and protection
equity release
life insurance
```

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

```cron
0 6 * * 1  cd /opt/callguard/packages/api && DATABASE_URL=... FCA_API_EMAIL=... FCA_API_KEY=... \
  npx tsx src/scripts/enrich-prospects-fca.ts --sweep --terms-file /opt/callguard/prospect-sweep-terms.txt --yes \
  >> /var/log/callguard-prospect-sweep.log 2>&1
```

Keep the term list in its own file (one term per line, `#` for comments —
`--terms-file` supports both) rather than inline in the crontab, so it can be
extended without editing the schedule.

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

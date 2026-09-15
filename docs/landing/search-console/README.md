# Search Console exports

The monthly topic scout reads these. Without them it can only judge demand from the
shape of the search results, which is a weak proxy — this folder is what makes its
recommendations evidence rather than opinion.

## What to export, once a month

Search Console → Performance → Search results:

1. Set the date range to the **last 3 months**.
2. Open the **Queries** tab.
3. Export → **Download CSV**.
4. Save it here as `queries-YYYY-MM.csv`, using the month you exported in.

If you also export the **Pages** tab, save it as `pages-YYYY-MM.csv`. That one shows
which URLs earn impressions, which is how the scout spots a page that nearly ranks.

## Why the files are committed

Query data is not personal data, and keeping the history is the point: a term whose
impressions are climbing across three exports is a better bet than one with a high
estimate and no trend. Do not delete old exports.

## What the scout does with them

- Finds queries the site already gets impressions for but ranks badly on. These are the
  cheapest wins and they beat any third-party volume estimate.
- Checks a proposed topic against terms the site already ranks for, so a new post does
  not compete with a page that already works.
- Reports honestly when the newest export is more than 5 weeks old, rather than passing
  stale numbers off as current.

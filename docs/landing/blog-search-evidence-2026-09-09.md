# CallGuard search evidence and revised priorities

Measured directly in the signed-in Google Search Console and Google Ads Keyword Planner on 9 September 2026. Search Console domain property: `sc-domain:callguardai.co.uk`. Google Ads account: CallGuard AI, customer ID `101-134-1995`. This evidence supplements the earlier blog proposal.

**Remediation update, 9 September 2026:** a fresh production check found that the repository release had reached the site after the initial review. The live sitemap matched all 33 repository URLs; every sitemap URL returned 200 and declared itself canonical; the non-www host rule worked; and the previously missing vulnerability article was live. Search Console's live tests found both the preferred AI QA URL and the vulnerability article available to Google. Indexing was requested for both, and the sitemap was resubmitted successfully; Search Console then reported 33 discovered sitemap pages instead of 32. Historical indexing counts will update only after Google recrawls and reprocesses the URLs.

## Scope and baseline

Search type: Web. Selected period: 3 months, displayed as 7 June–6 September 2026. Performance last updated 9 hours before inspection. These are observations of CallGuard's visibility, not estimates of total market search volume.

| Geography | Clicks | Impressions | CTR | Average position |
|---|---:|---:|---:|---:|
| All countries | 13 | 805 | 1.6% | 11.4 |
| United Kingdom | 7 | 259 | 2.7% | 10.6 |

[Search Console performance report](https://search.google.com/u/1/search-console/performance/search-analytics?resource_id=sc-domain%3Acallguardai.co.uk) (requires account access; default date ranges advance over time).

The overall position should not be interpreted as a typical commercial keyword ranking. The query list includes brand-like terms, very long questions and a search with explicit site exclusions. Their intent and representativeness differ. The sample is too small to forecast qualified leads or establish a reliable conversion rate.

## Query evidence

The following rows were read directly from the query tables. All listed non-branded rows had zero clicks during this period.

| Exact query | UK impressions | UK average position | All-country impressions | All-country average position |
|---|---:|---:|---:|---:|
| fca call recording | 9 | 43.4 | 19 | 46.2 |
| fca call recording regulations | 8 | 54.6 | 17 | 63.7 |
| 4 outcomes consumer duty | 2 | 10.5 | 2 | 10.5 |
| recording calls compliance | 1 | 2.0 | 1 | 2.0 |
| twilio media streams | Not recorded in this UK excerpt | — | 6 | 25.2 |
| twilio media stream | Not recorded in this UK excerpt | — | 3 | 25.0 |
| fca mobile phone recording | Not recorded in this UK excerpt | — | 2 | 67.5 |
| fca call recording compliance | Not recorded in this UK excerpt | — | 1 | 60.0 |

For context, `callguard` had 60 UK impressions, one click and position 5.2; `call guard` had 37 UK impressions, zero clicks and position 15.4. These are brand-like strings, but generic/other-brand intent is possible. Do not treat every matching string as someone deliberately seeking CallGuard AI.

The UK table also showed a 6-impression question comparing Twilio-compatible speech analytics products at position 2.8, and a 2-impression question about CRM/AWS Connect compliance integration at position 1.0. These support testing integration-related intent; they do not justify treating those exact sentences as substantial keyword markets.

Only 24 query rows were exposed globally; the UK view reported 15. Query tables exclude anonymised queries and may omit other rows. They do not account for all chart clicks, so the report cannot defensibly conclude that every other click was branded or non-branded. [Google's explanation](https://support.google.com/webmasters/answer/17011259?hl=en).

## Page evidence: all countries

| Page as reported by Google | Clicks | Impressions | Average position |
|---|---:|---:|---:|
| Non-www homepage | 9 | 440 | 6.6 |
| Non-www Twilio integration | 1 | 95 | 18.8 |
| Www Consumer Duty article | 2 | 25 | 25.2 |
| Non-www Consumer Duty article | 0 | 44 | 51.2 |
| Www AI call QA explainer | 0 | 61 | 6.3 |
| Www PECR/TPS article | 0 | 49 | 3.4 |
| Non-www AWS Connect integration | 0 | 38 | 10.1 |
| Www 100% call scoring article | 0 | 24 | 6.5 |
| Www AI versus human scoring article | 0 | 18 | 11.8 |
| Non-www mortgage advice use case | 0 | 2 | 7.5 |
| Www blog index | 0 | 2 | 4.0 |
| Non-www blog index | 0 | 1 | 9.0 |

These are historical page rows across all countries. Do not sum their impressions and call the result unique searches. Page and property aggregation differ, and chart/table totals can differ. [Google report guidance](https://support.google.com/webmasters/answer/7576553?hl=en).

The Consumer Duty page received the only two clicks shown for blog article rows in the complete 21-row all-country page table. That is a useful starting signal, but two clicks are not proof of meaningful demand. Twilio's all-country visibility is stronger than the mortgage page's, but it includes non-UK traffic; the UK table showed only six impressions for the Twilio page.

## Indexing evidence: a stronger immediate priority

Page indexing report last updated 4 September 2026:

| State | URLs |
|---|---:|
| Indexed | 19 |
| Discovered – currently not indexed | 23 |
| Page with redirect | 9 |
| Alternate page with proper canonical | 5 |
| Crawled – currently not indexed | 0 |

The 9 redirects and 5 canonical alternatives are not automatically defects. The 23 discovered URLs require investigation, particularly preferred content/commercial URLs. Google listed no last crawl for those examples.

The list included non-www versions of four articles: AI versus human scoring, PECR/TPS, 100% call scoring and the AI call QA explainer. It also included `/pricing`, `/templates/`, the MCOB mortgage scorecard, the comparison index and five comparison pages, CloudTalk and Microsoft Teams integrations, and four use-case pages.

[Discovered URL report](https://search.google.com/u/1/search-console/index/drilldown?resource_id=sc-domain%3Acallguardai.co.uk&item_key=CAMYFiAC).

A representative URL inspection established more detail:

- `https://callguardai.co.uk/blog/what-is-ai-call-qa`: not indexed, discovered via the sitemap, no referring page detected, no crawl recorded, no canonical data available.
- `https://www.callguardai.co.uk/blog/what-is-ai-call-qa`: indexed; last crawl 26 July 2026. User-declared canonical was the non-www URL, but Google selected the inspected www URL.
- Opening the www URL in the browser on 9 September redirected to the non-www article, which loaded successfully. The browser observation verifies the destination, not the HTTP redirect status code.

This is evidence of a mismatch between Google's stored index and today's preferred host. It does not establish that the current redirect is broken, nor that every article is absent from Google. Audit permanent redirects, canonical/internal-link/sitemap consistency and crawl access; encourage rediscovery of the preferred URLs and monitor recrawling. The report alone cannot identify why Google has not crawled those destinations.

## UK Keyword Planner evidence

Keyword Planner was set to the United Kingdom and Google search network. The exports cover 1 August 2025–31 July 2026. Because this account displays broad volume bands, the table preserves those bands instead of presenting the export's midpoint-like values as exact monthly searches. Google describes Planner figures as estimates; paid-ad competition is not an organic ranking-difficulty score. [Keyword Planner documentation](https://support.google.com/google-ads/answer/7337243/use-keyword-planner?hl=en-uk).

| UK average monthly band | Terms observed | Interpretation for CallGuard |
|---|---|---|
| 1K–10K | `consumer duty`, `fca consumer duty`, `tps checker` | Large headline demand, but materially different intent. Consumer Duty results favour authoritative FCA guidance; TPS checker is a tool task and showed a 90% three-month and year-on-year decline in Planner. Do not make either a generic blog-volume target |
| 100–1K | `conversation intelligence`, `call centre software`, `regulatory compliance software`, `vulnerable customers`, `mcob` | Broader category, regulatory or navigational demand. Conversation intelligence and regulatory compliance software support commercial category pages. MCOB and vulnerable customers need narrower, task-led articles |
| 10–100 | `fca call recording`, `fca call recording regulations`, `fca call recording requirements`, `call monitoring software`, `call compliance software`, `call quality assurance`, `call centre quality assurance`, `call quality scorecard`, `call quality scorecard template`, `call monitoring form template`, `call quality calibration`, `consumer duty checklist`, `mortgage compliance checklist`, `twilio speech analytics`, `pecr compliance`, `speech analytics software`, `ai call scoring`, `automated call scoring` | Smaller but closer to CallGuard's product and expertise. Group close variants by intent; never add them together as though each represented a separate audience |
| No reported volume | `consumer duty call monitoring`, `consumer duty outcomes monitoring`, `vulnerable customer call monitoring`, `mortgage call monitoring`, `mcob checklist`, `protection compliance checklist`, `twilio call monitoring`, `twilio call quality assurance`, `amazon connect quality assurance`, `fca call recording retention` | Suitable only where the task and product fit justify a focused test. A dash is not proof of zero searches |

The call-centre QA discovery run produced 220 ideas. Relevant variants included `call center qa`, `call center qa software`, `call center quality assurance software`, `contact center quality assurance software`, `call center quality monitoring`, `call quality monitoring software`, `customer service quality assurance` and `call scoring software`. Most displayed in the 10–100 band. These are one connected topic cluster, not 220 page opportunities.

Commercial signals support the distinction between article and product-page intent. Planner showed `ai call scoring` at 10–100 with medium paid competition and a £25.29–£127.60 top-of-page bid range; `regulatory compliance software` at 100–1K with low paid competition and £18.04–£43.31; and `call monitoring software` at 10–100 with low paid competition and £11.07–£61.83. Bid figures are advertising-market signals, not expected CallGuard CPCs, conversion rates or organic difficulty.

Search-result sampling also clarifies format. `consumer duty` is led by FCA policy, guidance and handbook resources. `conversation intelligence software` returns vendor and software-comparison pages, supporting a commercial landing/comparison format. `tps checker` returns an online number-checking utility, confirming tool intent. A blog article is unlikely to satisfy that query unless CallGuard offers a genuine checker.

## Revised priorities

| Priority | Recommendation | Evidence |
|---|---|---|
| 1 | Resolve publishing, sitemap and canonical discovery before expanding | 23 discovered-but-unindexed URLs, a verified preferred-host mismatch and the missing live vulnerability article |
| 2 | Build one authoritative FCA call-recording guide at the existing or best-matched URL | Three directly relevant terms in the 10–100 band, plus existing UK Search Console impressions for `fca call recording` and `fca call recording regulations` |
| 3 | Build a call-QA resource cluster around the existing AI QA article and a useful scorecard/template | Multiple 10–100 terms and many close variants; practical template results match the task intent. Consolidate variants into a hub, a guide and a downloadable/interactive resource |
| 4 | Rework the Consumer Duty article around monitoring evidence and the checklist | Existing blog clicks and a 10–100 `consumer duty checklist` term. The 1K–10K broad phrases are real demand but have authoritative, broad intent, so they are not a basis for a generic explainer |
| 5 | Strengthen commercial pages for conversation intelligence and regulatory compliance software | Both have 100–1K demand and product-category intent. Use supporting articles and comparisons; keep the main target on a commercial page |
| 6 | Improve the Twilio integration page and assess one implementation guide | 95 all-country page impressions and one click; `twilio speech analytics` is 10–100, while narrower Twilio QA phrases had no reported volume |
| 7 | Test mortgage, MCOB and vulnerability resources selectively | Strong buyer fit, but exact task terms mostly have no reported volume. `mcob` and `vulnerable customers` are broader 100–1K phrases with mixed intent |
| Avoid | A TPS-checker article or many near-duplicate keyword pages | TPS is tool intent with a sharp reported trend decline; close variants would create overlap without expanding the addressable audience |

The proposed index and article layouts remain usability and editorial recommendations. Volume data cannot prove that a framework change, card layout or contents sidebar will increase rankings. With only 13 worldwide Search Console clicks in the measured quarter, a large platform rebuild has a weaker case than reliable publishing, index consolidation and a small number of intent-matched resources.

No responsible traffic or lead forecast follows from banded volumes. The next forecast should wait until preferred URLs are indexed and several priority pages have accumulated at least a few months of UK impressions, clicks and conversion data.

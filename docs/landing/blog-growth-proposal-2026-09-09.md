# CallGuard AI blog growth proposal

Reviewed 9 September 2026. Proposal only; no production changes made.

**Subsequent evidence:** A signed-in Search Console and UK Keyword Planner review is now available in [the search evidence addendum](blog-search-evidence-2026-09-09.md). It establishes 13 worldwide clicks / 805 impressions and 7 UK clicks / 259 impressions for 7 June–6 September, plus 23 discovered-but-unindexed URLs. Keyword Planner shows 10–100 monthly bands across the FCA call-recording and call-QA/scorecard clusters, 100–1K for broader commercial categories such as conversation intelligence, and 1K–10K for broad Consumer Duty phrases whose intent is led by FCA resources. This moves publishing/index consolidation and a few intent-matched resources ahead of a substantial rebuild.

Build a focused resource library for UK regulated call monitoring. Prioritise reliable publishing, authoritative practical content and clear links between guides, templates and commercial pages. Keep the existing brand and public article URLs. A different framework alone will not generate organic demand.

## What was checked

The live blog index, a full Consumer Duty article, the PECR article's public text, the live sitemap, the newer vulnerability article's HTTP status, local Markdown sources, article template, generator, analytics and deployment instructions. A small search-results sample was used to inspect competing content formats.

GA4 reporting, backlinks and live Core Web Vitals were not accessed. Search Console and UK Keyword Planner were accessed; organic conversion baselines and backlink authority remain unknown. Historic numbers in the repository's August SEO review were not treated as current measurements.

## Findings and priorities

| Priority | Verified observation | Recommended action |
|---|---|---|
| P0 | The live index has five posts, all dated 5 May 2026. The local source contains a sixth, dated 27 August. `/blog/vulnerable-customer-call-monitoring` returned HTTP 404 during this review. | Review and publish the missing article with the regenerated index and sitemap. Verify the public release, not only the local build. |
| P0 | The live sitemap contains the original five articles and excludes the newer one. Blog entries still carry 5 May modification dates. | Release content, index and sitemap together. Keep modification dates tied to real changes. |
| P0 | The PECR article describes the Data (Use and Access) Bill as still in Parliament during 2026. | Correct it: Royal Assent was 19 June 2025. Distinguish enactment from commencement of individual provisions. [Government source](https://www.gov.uk/guidance/data-use-and-access-act-2025-data-protection-and-privacy-changes). |
| P0 | The PECR article treats new-customer live marketing calls as universally needing explicit consent and discusses soft opt-in without adequate channel distinctions. | Review against ICO guidance, including TPS/CTPS, objections and sector-specific exceptions. The soft opt-in described by ICO concerns email/text marketing; live-call rules differ. [ICO guidance](https://ico.org.uk/for-organisations/advice-for-small-organisations/direct-marketing-and-data-protection/marketing-and-data-protection-in-detail/). |
| P1 | The index is an undifferentiated grid with topic labels, a large introductory area and no topic navigation or featured practical resource. | Reduce the introductory space and introduce topic routes, a recommended starting guide and a useful template. |
| P1 | The inspected Consumer Duty article has headings and related links, but no named visible author/reviewer, source list, contents navigation or worked visual examples. | Introduce an evidence-led article template with named contributors, jump links, practical examples and primary sources. |
| P1 | The generator already produces static article HTML, index cards and sitemap entries, and validates required fields and related links. | Preserve these strengths while improving the authoring and release process. |
| P2 | Local analytics already includes consent-gated GA4 and a `generate_lead` event in the demo flow. | Extend existing measurement with content and CTA attribution; validate successful submissions in production without counting clicks as leads. |

The current design is clean and consistent. The opportunity is better editorial hierarchy and practical value. A lack of recent posts does not prove an SEO penalty; the missing release and lack of expanding subject coverage are the actionable issues.

The Consumer Duty piece also needs expert review of categorical statements about what each individual call must evidence. Separate an explicit regulatory requirement, guidance, an illustrative example and CallGuard's recommended QA practice. Call analysis can contribute evidence; avoid implying it proves every aspect of a firm's compliance. See the FCA's discussion of monitoring approaches, data and outcomes in its [insurance monitoring review](https://www.fca.org.uk/publications/multi-firm-reviews/insurance-multi-firm-review-outcomes-monitoring-under-consumer-duty).

## Proposed information architecture

Keep `/blog/` and existing `/blog/<slug>` URLs. Present the index as “Call QA & Compliance Resources”. Link existing `/templates/`, `/use-cases/`, `/integrations/` and `/compare/` pages into this library rather than creating duplicates.

Start with two substantial topic hubs, expanding the others when enough useful material exists:

| Topic | Informational content | Practical resource | Commercial destination |
|---|---|---|---|
| FCA compliance and Consumer Duty | Outcomes evidence, vulnerable customers, monitoring plans | Consumer Duty monitoring checklist | Existing financial-services page |
| Mortgage and protection QA | Mortgage call reviews, scorecard examples, call-to-application discrepancies | Existing MCOB scorecard and protection checklist | Existing mortgage page and relevant product explanation |
| Call quality and calibration | QA criteria, reviewer disagreement, AI evaluation, sampling | Calibration worksheet and QA scorecard | Existing BPO/contact-centre page |
| Outbound and collections | Carefully reviewed PECR/TPS and collections monitoring guidance | Sector-specific checklist | Existing outbound and collections pages |

Each hub should answer the broad question, explain a sensible reading sequence and link to its guides and tools. Create hubs as real editorial pages; avoid dozens of near-empty category or tag archives.

Each article should link contextually to its hub, the most relevant practical resource, closely related articles and a commercial page where it helps the reader. Add reciprocal links from relevant use-case pages. Related content should follow the reader's next question, rather than simply being the latest posts.

Use one primary search intent per page. For example, keep “mortgage call monitoring software” on the commercial page and “how to review a mortgage advice call” on an instructional article. Review overlapping query/page performance before merging or splitting content.

## Blog index layout

Recommended order:

1. Compact heading: “Call QA & Compliance Resources”. Supporting line: “Practical guides, scorecards and examples for UK compliance and QA teams.”
2. Topic navigation using ordinary crawlable links. Initially show only topics with worthwhile destinations.
3. One featured guide beside one practical resource, such as the mortgage scorecard. Feature editorially useful content; do not label it “most popular” without evidence.
4. “Start here” links for the primary audiences: compliance lead, mortgage/protection firm and QA manager.
5. Latest guides in a consistent card grid. Show one topic, a concise outcome-focused title, short summary, author and genuine publication/update date.
6. A small templates section linking to existing resources.
7. A restrained product invitation tied to the resource library.

Keep the current green palette, logo and typography. Use scorecard previews, annotated screenshots and diagrams where they convey information. Decorative AI stock images are a low priority.

On mobile, use a single column, wrapping topic navigation and visible labels. Keep the first useful guide close to the top. Add library search once the collection is large enough that browsing becomes difficult. When pagination becomes necessary, use linked pages instead of relying solely on infinite scroll.

## Article layout

```text
Home / Resources / Topic
Specific article title
One-sentence description of the outcome
Named author · Relevant reviewer · Published / Updated · Read time

Short answer or key takeaways
Relevant template link

Contents navigation     Main article
(desktop sidebar)       Clear headings
                        Worked scorecard or labelled example
                        Primary-source links near claims
                        Practical steps and limitations

Relevant next action
Sources and review note
Contributor biography
Two or three related resources
```

Use a readable body width of roughly 65–75 characters, generous line spacing and accessible contrast. On mobile, move contents into a compact disclosure above the article. Ensure heading anchors are not hidden underneath sticky navigation.

For a Consumer Duty article, give the reader a worked mapping from a monitoring objective to an example question, evidence and follow-up action. Label synthetic calls as illustrative. Use permissioned and properly anonymised examples if drawing on actual customers.

Show the author's relevant experience and a reviewer only where an actual review has happened. Link regulatory claims directly to FCA/ICO sources. Use a review date internally for maintenance and a visible updated date when content materially changes. Google's guidance specifically encourages clear authorship, sourcing and useful original work; it does not promise rankings for a byline alone. [Google content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content).

## Recommended publishing system

### Immediate improvement

Keep the existing generator while correcting and publishing current content. Replace the manual three-file upload process with a single reproducible marketing-site release. This resolves the verified failure sooner than waiting for a rebuild.

### Target system

For the fuller resource-library build, use Astro static generation with structured content collections and a Git-backed editor such as Keystatic. This fits the current Markdown content and static public website while making layouts and content relationships easier to maintain. [Astro content collections](https://docs.astro.build/en/guides/content-collections/) support schema validation and generated routes; [Keystatic](https://keystatic.com/docs/introduction) can store content locally or in GitHub.

Keep the public site statically rendered, with complete article text and links in the returned HTML. The authenticated editorial interface can run separately with an appropriate runtime; do not assume a remote editor can run entirely on the existing static Apache host. Validate that deployment choice before implementation. Keep this work scoped to the marketing/content layer.

| Content model | Fields |
|---|---|
| Article | Stable slug, title, description, summary, body, primary topic, audience, author, reviewer where applicable, publication date, material update date, review due date, status, hero image/alt text, sources, related resources and CTA |
| Author | Name, role, relevant experience, biography, optional photograph and verifiable professional links |
| Topic hub | Title, explanation, starting guide, ordered resources, linked commercial page |
| Resource | Template/tool title, explanation, format, preview, file or tool destination, related articles |

Derive read time, word count, canonical URL, breadcrumb, social metadata and sitemap from the content. Allow editorial overrides where genuinely needed. The current generator requires 14 front-matter fields and has a narrow Markdown renderer; a structured editor should remove repetitive metadata entry and support tables, images and reusable examples.

Workflow: draft → subject review → preview → publish → automated build/checks → complete release → public verification. Scheduled content needs a scheduled build or explicit publishing trigger; setting a future date alone is insufficient for static output.

Release checks should verify required metadata, valid JSON-LD, internal links, referenced assets, draft exclusion and uniqueness of URLs. After release, check all published article URLs return 200, match their canonicals, appear in the index/hub and sitemap, and have their expected content. Rollback should restore the preceding complete release. Exclude Markdown sources, internal templates and drafts from public build output.

Retain the existing article/breadcrumb schema and improve the contributor, date and image values to match visible content. Schema is descriptive metadata, not a traffic guarantee. [Google Article documentation](https://developers.google.com/search/docs/appearance/structured-data/article).

Preserve all existing URLs through migration. If a URL genuinely must change, map a direct permanent redirect and update its internal links and sitemap entry. Keep preview and internal-search pages out of the search index. Measure live performance before deciding whether speed is a material constraint.

## Content programme

Focus initially on FCA call recording and call-QA/scorecard workflows. Keyword Planner placed multiple terms in each cluster in the 10–100 UK monthly band, and Search Console already shows impressions for FCA call-recording queries. Treat close variants as clusters rather than separate page opportunities. Broader phrases such as `conversation intelligence` and `regulatory compliance software` sit in the 100–1K band but fit commercial category pages better than generic blog posts.

Search-results sampling showed practical templates competing for scorecard queries: [Zendesk's guide and template](https://www.zendesk.co.uk/blog/quality-assurance/workforce-optimization/qa-scorecard/), [Scorebuddy's downloadable scorecard](https://www.scorebuddycx.com/resources/call-center-qa-scorecard-template) and [HiveDesk's interactive scorecard](https://www.hivedesk.com/resources/sales-call-quality-assurance-scorecard-template). The format matches the measured cluster: answer the task and give readers something they can use. Planner's paid competition and bid figures do not establish organic ranking difficulty.

Suggested first queue, revised from Search Console, Keyword Planner and search-intent evidence:

| Order | Work | Distinctive value / next step |
|---|---|---|
| 1 | Fix publishing/indexing and correct the existing PECR/TPS article | Restore crawlable preferred URLs; make the regulatory distinctions source-backed rather than chase the broader TPS-checker term |
| 2 | Create or consolidate an FCA call-recording requirements guide | Cover recording, regulations and requirements in one authoritative page; these related terms each showed 10–100 and already appear in Search Console |
| 3 | Rework the existing AI call-QA article and publish a scorecard/template resource | Establish the hub, practical guide and reusable resource for the measured QA/scorecard cluster |
| 4 | Rework the existing Consumer Duty article | Focus on monitoring evidence and a practical checklist; avoid competing as another broad definition page |
| 5 | Call QA calibration: resolve reviewer disagreement | Downloadable worksheet and examples of ambiguous criteria within the QA cluster |
| 6 | Improve the conversation-intelligence/compliance commercial category story | Target commercial demand on the relevant product page and use supporting comparisons or implementation articles |
| 7 | Improve Twilio speech-analytics coverage | Strengthen the integration page first; add one implementation guide only if its intent is distinct |
| 8 | Review and publish the vulnerable-customer article, then test mortgage/MCOB resources | Strong product fit, but use Search Console response to decide how far to expand because narrow Planner terms had no reported volume |

Do not create another general “what is AI call QA” article: improve the existing one. Keep the operational 100% coverage article focused on implementation and label any financial model as illustrative.

Aim initially for two substantial new pieces and two meaningful updates each month. Adjust to actual expert-review capacity. Each new piece should offer at least one useful original contribution: a worked scorecard, annotated workflow, calculation, genuine interview or permissioned case study. Review volatile regulatory content more frequently and after relevant changes.

For earned links, make valuable template pages accessible without forcing an email address. Invite relevant integration partners, compliance practitioners and trade publications to reference genuinely useful resources. Distribute only through authorised outreach. Avoid buying links or producing many near-identical pages for slight keyword variations.

## Conversions and measurement

Use a relevant resource as the first action for informational readers. Then offer a product next step such as seeing the same scorecard applied in a demo. Keep the current demo flow and verify it; HTML mailto links alone do not establish that a modal is absent because local JavaScript intercepts them.

Before launching, establish Search Console baselines for the last 90 days and a comparable previous period, separating branded/non-branded queries, UK traffic and article/hub/template/commercial page groups. Check actual indexed URLs and Google's selected canonicals. Search-result counts are not a substitute.

Measure non-branded clicks and impressions by topic; article-to-template and article-to-commercial clicks; successful demo requests; and qualified leads or pipeline attributable to content where available. Extend GA4 events with content slug, topic and CTA position, respecting the existing consent controls and excluding personal information. Count confirmed demo submissions separately from opens and clicks. Expect analytics coverage to differ from Search Console because of consent and measurement definitions.

Use observed performance to decide the next action: impressions with weak clicks merit title/intent review; useful visits with little onward action merit better resource/CTA fit; pages with little search exposure need indexing, demand, differentiation and internal-link investigation.

## Delivery sequence

| Period | Deliverables | Completion evidence |
|---|---|---|
| First 2 weeks | Correct high-risk claims, review/publish missing post, establish release checks and measurement baseline | Expected article URLs live; correct index/sitemap; documented baseline |
| Weeks 3–4 | New article and index templates, two useful hubs, author/reviewer model, stronger template links | Desktop/mobile visual review, metadata/link checks, successful release verification |
| Weeks 5–8 | Implement the target authoring system if editorial needs justify it; publish the first practical guides/resources | An editor can draft, preview, review and publish without editing HTML or manually uploading files |
| Weeks 9–12 | Continue the content cadence, distribute useful resources, refresh from observed queries | Topic-level search report, resource engagement and qualified enquiry review |

Treat 90 days as the first evaluation window. Set traffic targets after establishing the baseline; this review does not support a defensible percentage-growth forecast. The first investment should fix publishing reliability and content credibility, followed by the templates and subject coverage that can attract qualified buyers.

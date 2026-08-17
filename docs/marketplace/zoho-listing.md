# CallGuard AI for Zoho CRM — marketplace listing draft

Status: **draft, not submitted anywhere.** Every claim below is traced to
shipped code or an existing operational doc — see the "Sources" line at the
end of each section during review, then strip those lines before actual
submission copy is pasted anywhere.

> **Before this is submitted anywhere: read the note at the bottom of this
> file ("Zoho Marketplace listing mechanism — open question").** CallGuard's
> Zoho integration is an OAuth connection *from* CallGuard *to* Zoho, not
> code that runs inside Zoho. Whether Zoho Marketplace can list that as-is,
> or whether a packaged Zoho extension needs to be built first, is
> unresolved and is not something this draft can settle. Do not submit this
> listing to Zoho Marketplace until that question is answered.

---

## Tagline

Compliance scores, written straight back onto the Zoho record they belong
to — automatically, every time a call is scored.

## Summary (one paragraph)

CallGuard AI scores sales and advice calls for FCA compliance, then writes
the result — score, pass/fail, when it was scored, and a link back to the
call — onto the matching Lead or Contact in your Zoho CRM, matched
automatically by the customer's phone number. When a call breaches
compliance, CallGuard also raises a Zoho Task on that record so the owner
has something to action. It's a one-way sync from CallGuard into Zoho:
CallGuard never changes a contact's details, ownership, or anything beyond
the compliance fields and breach tasks it's configured to write.

---

## Description (for a buyer)

CallGuard AI is standalone compliance-scoring software for regulated sales
and advice calls. This listing covers its Zoho CRM integration.

Once CallGuard has transcribed and scored a call (or, for firms that score a
whole sale as one unit, a full customer "journey" of calls), it looks up the
matching Zoho Lead or Contact by the customer's phone number and writes the
compliance outcome onto it: an overall score, a pass/fail result, when it
was scored, and a link back into CallGuard to review the call. If the call
breached a compliance rule, CallGuard also creates a Zoho Task on that
record, addressed to the record's owner, describing what was breached and
why.

For firms that score whole sales rather than individual calls, CallGuard can
also be triggered *from* Zoho: a workflow on a "sale" record tells CallGuard
which calls belong to that sale, and once scored, the result is written to a
separate QA module record alongside your team's own human QA marks — so the
AI score sits next to, not instead of, your existing quality process.

Matching is automatic and requires no manual linking: as long as the
customer's number that CallGuard sees on the call also exists on a Zoho
record, the result lands there. If a number matches more than one Zoho
record, CallGuard deliberately does not guess — it skips the write-back and
flags it for a person to resolve, because writing one customer's compliance
data onto a different customer's record would be worse than not writing it
at all.

---

## Features (each traceable to shipped behaviour)

- **Automatic write-back by phone match.** No manual linking between a
  CallGuard call and a Zoho record — CallGuard finds the Lead or Contact
  itself by the customer's phone number, tolerant of UK number formats
  (`+44…` vs `0…`).
- **Compliance score, pass/fail, timestamp and review link** written to
  configurable custom fields on the matched record.
- **Automatic breach Tasks.** When a call breaches compliance, CallGuard
  creates a Zoho Task on the matched record, addressed to the record owner,
  with a priority (High for critical/high-severity breaches) and a
  description listing each breach and the evidence for it.
- **Ambiguous-match protection.** If a phone number matches more than one
  Zoho record, CallGuard does not guess which is correct — it skips the
  write-back entirely and notifies an admin, rather than risk writing one
  customer's compliance data onto someone else's record.
- **Configurable module.** Works against either the Leads or Contacts
  module, whichever a firm's Zoho setup uses for sales records.
- **QA-module write-back for journey (sale) scoring.** For firms that score
  a whole sale as one unit, the AI score can be written into a separate,
  tenant-defined QA module record — alongside the tenant's own human QA
  marks — rather than overwriting them.
- **Retried, tracked delivery.** A failed write-back (Zoho rate limit or
  outage) is retried automatically with backoff; scoring itself is never
  blocked or delayed by Zoho being unreachable.
- **Product/policy detail lookup.** For firms with a related "policies sold"
  list on their sale record, CallGuard can read which product(s) and
  underwriting stage a sale covers, to score against the right rules for
  that product.
- **Encrypted, revocable connection.** Authorisation is OAuth — no password
  is ever shared with CallGuard, and access can be revoked from the Zoho
  side (Connected Apps) at any time.

*Sources: `packages/api/src/services/zoho.ts` (`attemptRecordWriteBack`,
`createBreachTask`, `findRecordByPhone` and `PhoneMatchResult`'s ambiguous
handling, `pushQARecord`, `fetchSaleProducts`, `retryZohoDelivery`);
`docs/zoho-integration.md`.*

---

## What data we access and why

- **What we request from Zoho (OAuth scopes).** `ZohoCRM.modules.ALL` (to
  read/update the Leads or Contacts module, create Tasks, and read/write the
  QA module), `ZohoCRM.settings.modules.READ` and
  `ZohoCRM.settings.fields.READ` (to verify the connection and read
  configured field metadata, e.g. product picklists), `ZohoCRM.settings.related_lists.READ`
  (to help set up related-list fields like policies-sold), and
  `ZohoCRM.users.READ` (to resolve an adviser's email to a Zoho user, so a
  QA record's owner can be set to the closing agent). CallGuard requests
  only these scopes; nothing broader.
- **Direction of the connection.** This is CallGuard reading from and
  writing to Zoho on the tenant's behalf, using credentials the tenant
  controls and can revoke at any time — not Zoho, or any third party,
  reading CallGuard's own data.
- **What gets written to Zoho.** Only a compliance score, pass/fail result,
  a timestamp, a link back to the call in CallGuard, and — on a breach — a
  Task with a description of what was breached. CallGuard never modifies a
  contact's existing details or ownership.
- **What's read from Zoho.** Phone numbers (to find the matching record),
  the fields CallGuard is told to write into (to check the match), and, only
  where configured, related "policies sold" records and file attachments (an
  insurer application PDF) for reconciliation against what the call actually
  covered.
- **Encryption at rest.** The OAuth refresh token, client secret, and any
  inbound-webhook signing secret are all encrypted at rest (AES-256-GCM) —
  never stored or logged in plaintext.
- **Personal data from calls is redacted before it ever reaches this
  integration.** The score, breach evidence, and any transcript excerpt
  quoted in a Zoho Task description come from a transcript that has already
  had personal, payment and health data replaced with typed tags (e.g.
  `[NAME_GIVEN_1]`) at transcription time — the underlying value is never
  stored by CallGuard or sent to Zoho.
- **Per-tenant retention.** Everything CallGuard holds about a call —
  including the record of what was written to Zoho — is purged on the
  tenant's own retention schedule (five years by default, configurable), or
  within 30 days of account cancellation.

*Sources: `packages/api/src/services/zoho.ts` (`OAUTH_SCOPE` constant and its
comment); `docs/zoho-integration.md` ("one-way sync… CallGuard never changes
the contact's details, ownership, or anything other than the compliance
fields and breach tasks"); `packages/api/src/services/crypto.ts`
(`aes-256-gcm`); `packages/api/src/services/transcription.ts`
(redaction categories); `packages/api/src/db/migrations/038_org_scoring_settings.sql`
and `packages/api/src/jobs/processors/retention-purge.ts` (retention).*

---

## Setup steps (condensed from `docs/zoho-integration.md`)

1. **Create the compliance fields in Zoho.** On the Leads module (or
   Contacts, if that's what the firm scores against): Compliance Score
   (Number/Decimal), Compliance Result (Pick List: Pass/Fail), Last Scored
   (Date/Time), CallGuard Link (URL). No custom fields are needed for
   breaches — those are standard Zoho Tasks.
2. **Create an OAuth client in Zoho.** In the Zoho API console for the
   firm's data centre (e.g. `api-console.zoho.eu` for a UK/EU tenant),
   create a Server-based Application, and set the Authorized Redirect URI
   to `https://app.callguardai.co.uk/api/integrations/zoho/callback`. Copy
   the generated Client ID and Client Secret.
3. **Connect Zoho in CallGuard.** Integrations → Zoho CRM → Connect. Paste
   the Client ID/Secret, confirm the data centre and module, then approve
   access when redirected to Zoho. The connection then shows as Active.
4. **Test.** Make a test call to (or from) a number on a Zoho record. Once
   CallGuard finishes scoring it, the Compliance Score, Result, Last Scored
   and CallGuard Link fields should be filled in on that record; a breach
   also raises a Task.

*Source: `docs/zoho-integration.md`.*

## Prerequisites

- An active CallGuard AI account with admin access.
- A Zoho CRM account with permission to create a Server-based Application in
  the Zoho API console, and to add custom fields to the Leads or Contacts
  module.
- Customer phone numbers stored on the Zoho Leads/Contacts records that
  should receive compliance results — matching is phone-based, so a record
  with no phone number (or the wrong one) will never be written to.
- A call-source integration already sending calls into CallGuard (e.g.
  CloudTalk) — Zoho write-back happens after a call is scored, so it has
  nothing to write until calls are flowing in.

## Support and documentation

- Full setup guide: `docs/zoho-integration.md` in the CallGuard repository.
- Support: hello@callguardai.co.uk

## Pricing

**Contact us.**

This is a deliberate placeholder, not an oversight. Marketplace policy on
several platforms — including Zoho, per its documented review process —
restricts changing a listed price for a defined period (30 business days)
after the listing goes live. Committing to a number now would lock it in
before pricing is finalised, so "Contact us" stands until pricing is ready
to be set permanently.

---

## Screenshots to capture

None of these exist yet — this is a shot list, not a set of image
references. Each should be captured from a real (demo-tenant, not client)
CallGuard account with Zoho connected, in light mode, at desktop width, with
any customer-identifying data either redacted (as CallGuard normally does)
or from clearly fictitious demo data.

1. **Integrations → Zoho CRM connection screen** — showing status Active,
   the configured data centre and module (Leads/Contacts), and the field-map
   settings for Compliance Score/Result/Last Scored/Link.
2. **A Zoho Lead/Contact record** with the Compliance Score, Compliance
   Result, Last Scored and CallGuard Link fields visibly populated —
   captured inside Zoho's own UI, on demo data only.
3. **A Zoho Task created from a breach**, showing the Subject, Priority and
   Description text CallGuard generated — captured inside Zoho's own UI, on
   demo data only.
4. **CallGuard's scored-call view** for the same call shown in screenshot 2,
   to visually pair "scored in CallGuard" with "appears in Zoho".
5. **The Zoho API console's OAuth client creation screen**, showing (with
   secret values blurred) the Server-based Application setup with the
   Authorized Redirect URI filled in, to illustrate step 2 of setup.

*None of these can be captured by this drafting task — no environment access
was used and none should be inferred from existing marketing screenshots
without confirming they still match current UI.*

---

## Zoho Marketplace listing mechanism — open question (investigate, don't resolve)

This section reports what the code and docs establish about the *shape* of
the integration, for someone else to take a submission decision on. It does
not resolve whether the listing can go ahead as drafted above.

### What the integration actually is, technically

- **Direction of the OAuth flow.** CallGuard's backend builds the Zoho
  authorize URL and sends the tenant's admin browser to it
  (`buildAuthorizeUrl` in `packages/api/src/services/zoho.ts`); Zoho then
  redirects back to a callback route CallGuard itself hosts
  (`GET /api/integrations/zoho/callback` in
  `packages/api/src/routes/integrations.ts`), which exchanges the
  authorization code for tokens and stores them. This is CallGuard acting as
  an OAuth **client** of Zoho's API — the same shape as any external SaaS
  product connecting to a customer's Zoho account, not Zoho hosting or
  running any CallGuard code.
- **What's installed where.** Nothing runs inside Zoho. The tenant creates
  their own "Server-based Application" OAuth client in Zoho's API console
  (`api-console.zoho.eu` or the regional equivalent) — a self-service,
  per-tenant credential pair (Client ID/Secret) that the tenant pastes into
  CallGuard. There is no Zoho widget, Deluge function, custom button, or
  any other artifact that lives inside the customer's Zoho account. All
  logic — matching, scoring, writing fields, creating tasks — runs on
  CallGuard's own servers and talks to Zoho purely over its REST API
  (`/crm/v8/...` calls in `zoho.ts`).
- **Scopes requested.** `ZohoCRM.modules.ALL`, `ZohoCRM.settings.modules.READ`,
  `ZohoCRM.settings.fields.READ`, `ZohoCRM.settings.related_lists.READ`,
  `ZohoCRM.users.READ` — all read/write CRM data scopes, requested via a
  standard OAuth "offline" + "consent" authorize request. There is no
  extension-specific scope or manifest involved.

### Whether this shape can be listed as-is

**Established, not guessed:** Zoho Marketplace, as described in the brief and
consistent with Zoho's own public developer positioning, lists **extensions**
— packages built against Zoho's Extension SDK (widgets, functions, custom
UI panels) that get installed *into* a customer's Zoho CRM account and are
reviewed by Zoho for how they behave inside Zoho's own interface. What
CallGuard has is a **self-hosted OAuth integration**: a "Connect your Zoho
account" flow that any tenant configures from outside Zoho, using a
standard server-based OAuth client they create themselves. This is a
fundamentally different distribution shape from a marketplace extension —
it's closer to what a SaaS product calls a "native integration" or
"connected app" than to a packaged Zoho extension.

**What I could not establish from this codebase:** whether Zoho Marketplace
has a listing category for this OAuth-connector shape (some marketplaces do
list "connected apps" that use OAuth without requiring an installed
package; whether Zoho's does, and what its review actually tests in that
case, is not something `services/zoho.ts` or `docs/zoho-integration.md` can
answer — it depends on Zoho's current marketplace submission requirements,
which weren't read as part of this task). I did not access Zoho's developer
or marketplace documentation, so I cannot state with confidence whether
CallGuard's current shape is submittable as-is, needs a thin extension
wrapper, or needs a full extension rebuild. This is the open question this
section is flagging, not answering.

### If an extension turned out to be required — rough shape, not a spec

If Zoho's marketplace does require an installed extension rather than an
external OAuth connector, a **minimal** one would likely need to:

- Be built and packaged with Zoho's Extension SDK/CLI (a distinct toolchain
  and packaging format from anything in this repo).
- Provide, at minimum, some UI presence inside Zoho — e.g. a widget on the
  Lead/Contact/Deal detail page showing the CallGuard compliance score and a
  link out, since Zoho's review is described (per the brief) as testing
  that "the extension works as promised" from within Zoho's own interface,
  not just via an external API call.
- Either proxy calls to CallGuard's existing API (so the extension is a thin
  UI shell over the API that already exists) or replicate some of that
  logic using Zoho's own Deluge scripting — the former is far closer to
  what already ships and would need no changes to `zoho.ts`.
- Handle its own OAuth/installation lifecycle the way Zoho extensions
  require (install/uninstall hooks, extension-specific auth), which is a
  different mechanism from the tenant-created Server-based Application
  CallGuard uses today — the two would likely need to coexist or one would
  replace the other, and working out which is a product decision, not
  something inferable from the code.

This is a rough sketch based on what the brief describes about Zoho
Marketplace's review model, not a scoped plan — building it would need
someone to actually read Zoho's current extension documentation first.

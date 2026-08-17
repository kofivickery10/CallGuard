# CallGuard AI for CloudTalk — marketplace listing draft

Status: **draft, not submitted anywhere.** Written for a CloudTalk app-marketplace
listing (or an equivalent "integrations" directory entry). Every claim below is
traced to shipped code or an existing operational doc — see the "Sources"
line at the end of each section during review, then strip those lines before
actual submission copy is pasted anywhere.

---

## Tagline

AI compliance scoring for every CloudTalk call — transcribed, scored, and
matched to the right agent automatically.

## Summary (one paragraph)

CallGuard AI turns CloudTalk's "Recording Uploaded" webhook into automatic,
FCA-aligned compliance QA. Point CloudTalk at CallGuard once — no code, no
middleware — and every call recording is pulled, transcribed with
personal-data redaction, scored against your firm's own compliance
scorecard, and attributed to the correct adviser using CloudTalk's stable
agent ID rather than a fragile name match. Breaches and low scores raise
alerts; nothing sits in a queue waiting for a human to notice it.

---

## Description (for a buyer)

CallGuard AI is standalone compliance-scoring software for regulated sales
and advice calls. This listing covers its CloudTalk integration.

CloudTalk fires a webhook when a call recording is ready. CallGuard listens
for that webhook, downloads the recording using your CloudTalk API
credentials, and runs it through the same pipeline as every other call in
the system: speaker-separated transcription with source-side personal-data
redaction, an AI compliance score against your firm's scorecard, and
automatic breach alerting. The result — score, pass/fail, and any breach
evidence — appears in the CallGuard dashboard and, if you also connect Zoho
CRM, is written back to the matching customer record there.

There is nothing to install inside CloudTalk beyond an outbound webhook
pointed at CallGuard, and nothing to run on your own infrastructure. Setup
is an API key and a webhook URL.

---

## Features (each traceable to shipped behaviour)

- **Automatic ingestion from CloudTalk's "Recording Uploaded" webhook.** No
  manual export or upload; CallGuard fetches the recording itself once the
  webhook fires.
- **Agent attribution by CloudTalk's stable numeric agent ID**, not by
  matching names — avoiding the misattribution that comes from a webhook,
  an agent roster and CallGuard each spelling the same person's name
  differently.
- **Tolerant field mapping.** CallGuard's default field map tries several
  common CloudTalk payload key names for each field (recording URL, agent,
  customer number, direction) and a tenant-specific override can be set if
  an account's payload uses different keys — no waiting on a CallGuard
  release to support a variant payload shape.
- **Idempotent by design.** Each webhook delivery is deduplicated on
  CloudTalk's own call id, so a retried delivery from CloudTalk never scores
  the same call twice.
- **Optional HMAC webhook verification.** A signing secret can be set on the
  CloudTalk connection; once set, CallGuard rejects any webhook request
  whose HMAC-SHA256 signature doesn't match.
- **Call-history backfill by phone number.** With CloudTalk API credentials
  on file, CallGuard can pull a customer's CloudTalk call history directly,
  so a multi-call sale can be assembled and scored as one compliance
  journey even when an earlier call predates the CloudTalk connection being
  set up.
- **Direction-aware speaker labelling.** An optional `direction` field on the
  webhook (inbound/outbound) overrides the tenant's default assumption
  about who speaks first on a mono recording, improving agent/customer
  label accuracy per call rather than per a single tenant-wide guess.
- **No infrastructure to run.** Unlike CallGuard's AWS Connect integration
  (which needs a small Lambda bridge), CloudTalk's webhook posts straight to
  CallGuard's endpoint.

*Sources: `docs/cloudtalk-integration.md`; `packages/api/src/services/cloudtalk.ts`
(agent-ID matching, call-history backfill, `natSig` phone matching);
`landing/integrations/cloudtalk.html` (idempotency, HMAC verification, no-Lambda
positioning — kept consistent with this existing public copy).*

---

## What data we access and why

For a compliance product, what we touch and how we protect it is the
product, not a footnote. In short: CallGuard only ever reads what CloudTalk's
webhook sends and the recording it points to; personal data is stripped
before it is ever written to disk or shown to an AI model; and everything
that remains is encrypted at rest with a defined deletion schedule.

- **What we request from CloudTalk.** The webhook payload (recording URL,
  call id, agent identifier, customer number, call direction) and, if
  configured, read access to CloudTalk's REST API to download the recording
  and to pull an agent roster / historical call list. CallGuard does not
  request write access to CloudTalk and never modifies anything in your
  CloudTalk account.
- **Redaction happens before storage, not after.** Transcription runs
  through Deepgram with redaction enabled for personal, payment and health
  data categories (name, date of birth, email, address, card/bank details,
  health information, and more). Detected values are replaced with typed
  tags like `[NAME_GIVEN_1]` at transcription time — the underlying value
  never reaches CallGuard's database or any AI scoring pass. Card and bank
  details specifically can never be configured to bypass this, whatever a
  tenant's settings say; a second, CallGuard-built pass also catches spoken
  bank details that per-entity tagging alone can miss.
- **Encryption at rest.** Call audio is encrypted at rest with AES-256-GCM
  before it is written to storage. Secrets CallGuard holds on your behalf
  (CloudTalk API credentials, webhook signing secret) are encrypted the same
  way, never stored or logged in plaintext.
- **Per-tenant retention, not a fixed global policy.** Each organisation has
  its own retention window (five years by default, configurable), after
  which the recording and its associated data are permanently purged by a
  daily automated job — not just hidden from view. Calls are archived out of
  the default portal view after two years but the underlying data is kept
  until the retention window lapses. If an account is cancelled, all its
  data is purged within 30 days.
- **Scoped access.** CallGuard is multi-tenant; an API key or user session
  only ever sees the data belonging to its own organisation.

*Sources: `packages/api/src/services/transcription.ts` (`REDACTION_CATEGORIES`,
`NEVER_UNREDACTED`, `resolveRedactCategories`, source-side Deepgram redaction);
`packages/api/src/services/crypto.ts` (`aes-256-gcm`); `packages/api/src/db/migrations/038_org_scoring_settings.sql`
(`retention_days`, default 1825 = 5 years); `packages/api/src/jobs/processors/retention-purge.ts`
(2yr archive, retention-window purge, 30-day post-cancellation purge);
CLAUDE.md (source-side PII/PCI/PHI redaction description).*

---

## Setup steps (condensed from `docs/cloudtalk-integration.md`)

1. **Create a CallGuard API key.** In CallGuard: Integrations → API keys →
   create. Copy the key — it's shown once.
2. **Add a webhook in CloudTalk.** In CloudTalk's Call Flow Designer, add an
   automation on the "Recording Uploaded" event using the HTTP Request
   action:
   ```
   POST https://app.callguardai.co.uk/api/ingestion/cloudtalk
   Header:  X-API-Key: <your CallGuard API key>
   Content-Type: application/json
   ```
   If your CloudTalk plan only exposes a plain webhook URL field (no custom
   headers), pass the key as a query parameter instead:
   `...?api_key=<your CallGuard API key>`.
3. **Set the webhook body.** Include the recording URL and call/agent
   identifiers; CallGuard reads several common CloudTalk field names
   tolerantly, so most accounts need no customisation.
4. **Map agents.** If CloudTalk's automation only sends a numeric
   `agent_id` (not an email), map it against each adviser in CallGuard under
   Team → Dialler agent ID.
5. **(Optional, recommended) Set a webhook signing secret.** In CallGuard's
   Integrations → CloudTalk, add a signing secret, then configure CloudTalk's
   automation to send an HMAC-SHA256 signature header. Once set, CallGuard
   rejects any request without a matching signature.
6. **(Optional) Set CloudTalk API credentials** if your CloudTalk recording
   links require authentication to download, so CallGuard can fetch them.
7. **Test.** Make a test call in CloudTalk; within about a minute it should
   appear in CallGuard, transcribed and scored against your active
   scorecard.

*Source: `docs/cloudtalk-integration.md`.*

## Prerequisites

- An active CallGuard AI account with admin access, and an active CloudTalk
  account with permission to configure Call Flow Designer automations.
- A compliance scorecard already set up in CallGuard (or use CallGuard's
  default) so scoring has something to score against.
- CloudTalk API key + secret on hand if recording URLs require
  authentication to download.
- (Optional) A Zoho CRM connection already configured in CallGuard, if
  scored calls should write back to CRM records — this is a separate
  integration.

## Support and documentation

- Full setup guide: `docs/cloudtalk-integration.md` in the CallGuard
  repository (also published at the CallGuard docs site).
- Public integration page: https://callguardai.co.uk/integrations/cloudtalk
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
CallGuard account with CloudTalk connected, in light mode, at desktop width,
with any customer-identifying data either redacted (as CallGuard normally
does) or from clearly fictitious demo data.

1. **Integrations → CloudTalk connection screen** — showing the connection
   status as Active, the fetch-delay setting, and (if set) the signing
   secret field masked.
2. **A scored call's transcript view** — showing agent/customer speaker
   labels, at least one redacted-PII tag (e.g. `[NAME_GIVEN_1]`) visible in
   the transcript, and the compliance score panel alongside it.
3. **The calls list/dashboard filtered to CloudTalk-sourced calls** —
   showing several rows with score, pass/fail, and agent columns populated,
   to demonstrate volume and attribution.
4. **A breach detail view** — one call with a flagged compliance breach,
   showing the evidence excerpt and severity, to show what an alert looks
   like in practice.
5. **The CloudTalk webhook configuration screen inside CloudTalk itself**
   (Call Flow Designer → Recording Uploaded automation), showing the HTTP
   Request action pointed at CallGuard's ingestion URL with the header
   fields filled in (API key value blurred/redacted before use).

*None of these can be captured by this drafting task — no environment access
was used and none should be inferred from existing marketing screenshots
without confirming they still match current UI.*

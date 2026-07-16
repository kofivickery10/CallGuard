# Connecting CloudTalk to CallGuard

CallGuard ingests CloudTalk call recordings automatically when CloudTalk's
**"Recording Uploaded"** webhook posts to CallGuard's CloudTalk endpoint. Each
recording is downloaded, transcribed, and scored, and attributed to the right
adviser by their CloudTalk agent email (or agent id).

## 1. Create a CallGuard API key
In CallGuard: **Integrations → API keys → create**. Copy the key (shown once).

## 2. Point CloudTalk at CallGuard
In CloudTalk, add an automation on the **Recording Uploaded** event using the
**HTTP Request** action (Call Flow Designer → Actions), which lets you set a
method, custom headers and a JSON body. Configure it as:

```
POST https://app.callguardai.co.uk/api/ingestion/cloudtalk
Header:  X-API-Key: <your CallGuard API key>
Content-Type: application/json
```

**If your CloudTalk plan only offers a plain "Webhook URL" field** (no custom
headers), pass the key as a query parameter instead — CallGuard accepts either:

```
POST https://app.callguardai.co.uk/api/ingestion/cloudtalk?api_key=<your CallGuard API key>
```

The header is preferred where available (a URL-embedded key can end up in
infrastructure access logs, e.g. a load balancer's), so use this only when
there's genuinely no way to set a custom header.

Body — include the recording URL plus call/agent identifiers. The receiver reads
these tolerantly, so any of the common CloudTalk field names work:

```json
{
  "recording_url": "<URL of the call recording>",
  "call_uuid": "<CloudTalk call uuid>",
  "agent_email": "<adviser's email in CloudTalk>",
  "external_number": "<customer phone>",
  "direction": "<inbound or outbound, if CloudTalk's automation editor exposes it>"
}
```

- **Agent attribution**: `agent_email` is matched to the CallGuard adviser with
  that email. If CloudTalk only sends a numeric `agent_id`, map it on each adviser
  via **Team → Dialler agent ID** instead.
- **Idempotency**: `call_uuid` is stored as the external id, so re-delivery of the
  same recording won't create duplicates.
- **Direction** (optional but recommended for outbound-calling tenants): if your
  CloudTalk automation can include a call-direction variable, send it as
  `direction` (or `type`/`call_type`/`call_direction` — any of these are tried).
  Recognised values: `inbound`/`incoming`/`in` and `outbound`/`outgoing`/`out`.
  This overrides the tenant's default assumption about which party speaks first
  on a mono recording, so agent/customer labels come out right per call instead
  of per a single tenant-wide guess. If CloudTalk doesn't expose a direction
  variable, this can be left out — the tenant's static default
  (`mono_first_speaker`, set via `PUT /api/organization/scoring-settings`, no
  UI toggle yet) is used instead.
- **Field name mismatch**: if CloudTalk sends any of the above under a different
  key than listed, a custom `field_map` can be set via `POST
  /api/ingestion/dialer-connections` (admin JWT auth; no UI for this yet, only
  fetch delay/history window/signing secret are exposed in **Integrations →
  CloudTalk**) — the receiver checks your custom mapping first, falling back
  to the defaults above.

## 2.5 Verify webhook authenticity (optional, recommended)
By default CallGuard trusts any request bearing a valid `X-API-Key`. For a
stronger check, set a signing secret on your CloudTalk connection
(**Integrations → CloudTalk**, "Webhook signing secret"), then have CloudTalk's
automation send:

```
X-CallGuard-Dialer-Signature: sha256=<HMAC-SHA256 of the raw request body, hex, using the signing secret>
```

Once a secret is set, requests without a matching signature are rejected (401).
Leave it unset while you're still testing the integration.

## 3. If recording URLs require authentication
CloudTalk recording links may need CloudTalk API credentials to download. If so,
set these on the CallGuard server (`.env`) and restart:

```
CLOUDTALK_API_KEY_ID=...
CLOUDTALK_API_SECRET=...
```

CallGuard will send them as Basic auth when fetching the recording. If CloudTalk's
webhook gives a public/temporary URL, this isn't needed.

## 4. Test
Make a test call in CloudTalk. When the recording uploads, the webhook fires and
the call should appear in CallGuard within a minute, transcribed and scored
against the org's active scorecard, attributed to the adviser.

If the call doesn't appear, send a copy of CloudTalk's webhook payload — the
field mapping can be adjusted to match your CloudTalk setup. Manual upload always
works as a fallback in the meantime.

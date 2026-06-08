# Connecting CloudTalk to CallGuard

CallGuard ingests CloudTalk call recordings automatically when CloudTalk's
**"Recording Uploaded"** webhook posts to CallGuard's CloudTalk endpoint. Each
recording is downloaded, transcribed, and scored, and attributed to the right
adviser by their CloudTalk agent email (or agent id).

## 1. Create a CallGuard API key
In CallGuard: **Integrations → API keys → create**. Copy the key (shown once).

## 2. Point CloudTalk at CallGuard
In CloudTalk, add an automation/webhook on the **Recording Uploaded** event that
sends an HTTP `POST` to:

```
POST https://app.callguardai.co.uk/api/ingestion/cloudtalk
Header:  X-API-Key: <your CallGuard API key>
Content-Type: application/json
```

Body — include the recording URL plus call/agent identifiers. The receiver reads
these tolerantly, so any of the common CloudTalk field names work:

```json
{
  "recording_url": "<URL of the call recording>",
  "call_uuid": "<CloudTalk call uuid>",
  "agent_email": "<adviser's email in CloudTalk>",
  "external_number": "<customer phone>"
}
```

- **Agent attribution**: `agent_email` is matched to the CallGuard adviser with
  that email. If CloudTalk only sends a numeric `agent_id`, map it on each adviser
  via **Team → Dialler agent ID** instead.
- **Idempotency**: `call_uuid` is stored as the external id, so re-delivery of the
  same recording won't create duplicates.

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

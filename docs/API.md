# CallGuard AI API Reference

Version 1.0 · Last updated 6 May 2026

This document covers everything an integration team needs to push call recordings into CallGuard AI, fetch the scoring results back, and (optionally) receive HMAC-signed webhooks for live streaming sessions. It assumes you have a CallGuard AI account.

If you have a question this document does not answer, email [hello@callguardai.co.uk](mailto:hello@callguardai.co.uk) and we will reply within one working day.

---

## Contents

1. [Quick start](#quick-start)
2. [Base URL and authentication](#base-url-and-authentication)
3. [Get started: list your scorecards](#get-started-list-your-scorecards)
4. [Ingest a call](#ingest-a-call)
5. [Fetch a call's result](#fetch-a-calls-result)
6. [Bulk import (UI flow)](#bulk-import-ui-flow)
7. [Live streaming (WebSocket)](#live-streaming-websocket)
8. [Webhooks for live streaming](#webhooks-for-live-streaming)
9. [Status codes and error responses](#status-codes-and-error-responses)
10. [Rate limits](#rate-limits)
11. [Common integration patterns](#common-integration-patterns)
12. [Reference: data shapes](#reference-data-shapes)
13. [Versioning and changelog](#versioning-and-changelog)

---

## Quick start

The minimum integration to get a scored call back is two API calls.

```bash
# 1. Push a call recording in
curl -X POST "https://app.callguardai.co.uk/api/ingestion/calls" \
  -H "X-API-Key: cg_live_..." \
  -F "audio=@call.mp3" \
  -F "external_id=crm-12345"
# → { "id": "8f2a...", "status": "uploaded", "external_id": "crm-12345", ... }

# 2. Pull the result back when ready (poll every few seconds)
curl "https://app.callguardai.co.uk/api/ingestion/calls/8f2a.../result" \
  -H "X-API-Key: cg_live_..."
# → { "status": "scored", "result": { overall_score, pass, items, breaches, coaching } }
```

That's it. Everything else in this document is detail and convenience.

---

## Base URL and authentication

**Production base URL**

```
https://app.callguardai.co.uk
```

All API endpoints are scoped under `/api/`. The streaming WebSocket lives under `/v1/`.

### Authentication: X-API-Key header

API endpoints in this document use API key authentication. Mint a key in the **Integrations** page of your CallGuard AI dashboard (admin role required). Treat the key like a password.

```
X-API-Key: cg_live_<your-key>
```

You can mint, list and revoke keys in the dashboard. Keys are tenant-scoped: an API key only ever sees its own organization's data.

> The dashboard UI itself uses JWT cookies, but every endpoint documented here accepts API key auth. You do not need to worry about JWT.

### TLS

All requests must be over HTTPS. The API will reject HTTP requests with 301 redirects.

---

## Get started: list your scorecards

Before you ingest calls, list the scorecards you have configured. This matters when you score per-campaign or per-client (BPOs typically run multiple scorecards in one CallGuard organization).

### `GET /api/ingestion/scorecards`

```bash
curl "https://app.callguardai.co.uk/api/ingestion/scorecards" \
  -H "X-API-Key: cg_live_..."
```

**Response**

```json
{
  "data": [
    {
      "id": "8f2a4d2c-9b0e-4d61-a4c8-1e0b9f5f3c01",
      "name": "Acme Energy outbound",
      "description": "PECR + TPS + fair-value tests for Acme Q2 campaign",
      "is_active": false,
      "created_at": "2026-04-12T09:14:21.000Z"
    },
    {
      "id": "33c1b2af-a48c-4d12-b6c1-8fa7c4e2d8e6",
      "name": "BT Broadband customer service",
      "description": "Empathy + first-call-resolution",
      "is_active": true,
      "created_at": "2026-04-01T11:02:00.000Z"
    }
  ]
}
```

Use the `id` field on the next call to specify which scorecard each call should be scored against.

---

## Ingest a call

### `POST /api/ingestion/calls`

Accepts either an audio file (multipart) or an `audio_url` (JSON). Returns a call identifier the moment the call is queued for processing. Scoring happens asynchronously: poll the result endpoint.

#### Option A: multipart audio upload

```bash
curl -X POST "https://app.callguardai.co.uk/api/ingestion/calls" \
  -H "X-API-Key: cg_live_..." \
  -F "audio=@call-20260506-001.mp3" \
  -F "external_id=crm-12345" \
  -F "agent_name=Marcus Webb" \
  -F "customer_phone=+44 7468 432 368" \
  -F "call_date=2026-05-06T10:14:00Z" \
  -F "tags=client:acme,campaign:q2-acquisition" \
  -F "scorecard_id=8f2a4d2c-9b0e-4d61-a4c8-1e0b9f5f3c01"
```

#### Option B: pull audio from a URL

```bash
curl -X POST "https://app.callguardai.co.uk/api/ingestion/calls" \
  -H "X-API-Key: cg_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "audio_url": "https://your-archive.example.com/call-001.mp3",
    "agent_name": "Marcus Webb",
    "external_id": "crm-12345",
    "scorecard_id": "8f2a4d2c-9b0e-4d61-a4c8-1e0b9f5f3c01"
  }'
```

#### Fields

| Field | Required | Notes |
|---|---|---|
| `audio` | one of two | Multipart file. WAV, MP3, OGG, WebM, M4A, μ-law, Opus all supported. Up to 500 MB. |
| `audio_url` | one of two | HTTPS URL we can fetch. Must be publicly resolvable or signed/short-lived. |
| `external_id` | optional | Your own identifier (CRM record id, etc.). Used for deduplication: re-ingesting with the same `external_id` returns the existing call instead of creating a duplicate. Highly recommended. |
| `agent_name` | optional | Free text. We auto-match to a CallGuard user account if the name matches an existing member. |
| `agent_id` | optional | Direct UUID of a CallGuard user. Use this if you already know it; overrides agent_name matching. |
| `customer_phone` | optional | Free text, no formatting requirements. |
| `call_date` | optional | ISO 8601 timestamp. Defaults to now. |
| `tags` | optional | Comma-separated string OR JSON array. Used for filtering in the dashboard. |
| `scorecard_id` | optional | UUID of a scorecard from `GET /api/ingestion/scorecards`. If omitted, the org's active scorecard is used. |

#### Response (201 Created, or 200 OK if duplicate)

```json
{
  "id": "8f2a4d2c-9b0e-4d61-a4c8-1e0b9f5f3c01",
  "status": "uploaded",
  "external_id": "crm-12345",
  "created_at": "2026-05-06T10:14:23.142Z",
  "is_duplicate": false
}
```

If `is_duplicate: true`, the existing call's id is returned. Either way, the `id` is what you use to fetch results.

---

## Fetch a call's result

### `GET /api/ingestion/calls/:id/result`

Use the `id` returned from ingestion. Poll every 3 to 10 seconds until the call lands on `scored` or `failed`.

```bash
curl "https://app.callguardai.co.uk/api/ingestion/calls/8f2a.../result" \
  -H "X-API-Key: cg_live_..."
```

#### Response while still processing

The full call metadata is returned with `result: null`. Status progresses through `uploaded` → `transcribing` → `transcribed` → `scoring` → `scored` (or `failed`).

```json
{
  "id": "8f2a...",
  "external_id": "crm-12345",
  "status": "transcribing",
  "agent_name": "Marcus Webb",
  "call_date": "2026-05-06T10:14:00.000Z",
  "duration_seconds": null,
  "created_at": "2026-05-06T10:14:23.142Z",
  "result": null
}
```

#### Response when scored

```json
{
  "id": "8f2a...",
  "external_id": "crm-12345",
  "status": "scored",
  "agent_name": "Marcus Webb",
  "call_date": "2026-05-06T10:14:00.000Z",
  "duration_seconds": 312.4,
  "created_at": "2026-05-06T10:14:23.142Z",
  "result": {
    "scorecard_id": "8f2a4d2c-9b0e-4d61-a4c8-1e0b9f5f3c01",
    "scored_at": "2026-05-06T10:15:01.918Z",
    "overall_score": 87.5,
    "pass": true,
    "items": [
      {
        "scorecard_item_id": "11111111-...",
        "label": "Adviser identity disclosed",
        "description": "Adviser introduced themselves and confirmed FCA authorisation.",
        "normalized_score": 100,
        "pass": true,
        "evidence": "Hi, this is Marcus from CallGuard Wealth, I am authorised by the FCA under reference 123456.",
        "reasoning": "Adviser stated full name, firm, and FCA reference clearly within the opening 30 seconds."
      },
      {
        "scorecard_item_id": "22222222-...",
        "label": "Charges disclosed clearly",
        "normalized_score": 0,
        "pass": false,
        "evidence": "Yeah our fee is point eight five percent annually.",
        "reasoning": "Charges given as a percentage only, with no pound-and-pence equivalent over the customer's term."
      }
    ],
    "breaches": [
      {
        "scorecard_item_id": "22222222-...",
        "label": "Charges disclosed clearly",
        "severity": "high",
        "evidence": "Yeah our fee is point eight five percent annually."
      }
    ],
    "coaching": {
      "summary": "Marcus opened the call cleanly with full adviser identification but stumbled on the charges disclosure. ...",
      "strengths": [
        "Clean caller identification within the opening 30 seconds.",
        "Empathy when the customer mentioned recent redundancy."
      ],
      "improvements": [
        "Always quote charges as both a percentage AND a pound-and-pence figure over the customer's investment horizon.",
        "Slow the close so the customer can paraphrase the recommendation back."
      ],
      "next_actions": [
        "On the next 5 calls, explicitly ask the customer to repeat the recommendation in their own words before closing."
      ]
    }
  }
}
```

If the call failed (corrupt audio, no scorecard configured, etc.), `status` will be `failed` and `result` remains `null`. Inspect the call detail in the dashboard for the underlying error.

---

## Bulk import (UI flow)

For backfilling historical archives, the most efficient path is the **Bulk Import** feature on the **Upload** page in the dashboard. Paste a CSV with up to 200 rows; each row is downloaded, ingested, and scored.

There is also an admin-only JWT endpoint (`POST /api/calls/bulk-import`) that the UI uses internally. If you want to drive bulk imports programmatically rather than through the UI, use multiple parallel `POST /api/ingestion/calls` requests with the API key auth instead. That path scales to millions of calls without a per-request row cap.

---

## Live streaming (WebSocket)

Live streaming lets you stream call audio as it happens, get a live transcript, and receive mid-call breach alerts via webhook (see next section). Typical use cases: outbound dialer integration (Twilio Media Streams, AWS Connect Voice Streams, Genesys SIPREC), and embedding scoring inside an agent desktop.

The flow:

1. Mint a streaming session token with `POST /v1/sessions/mint-token` (X-API-Key auth)
2. Open a WebSocket connection to the returned `ws_url`
3. Send audio frames over the socket
4. Receive transcript and breach events back over the same socket, plus webhooks to your registered URL

Detailed protocol documentation including frame formats per dialer adapter is available on request — email [hello@callguardai.co.uk](mailto:hello@callguardai.co.uk).

---

## Webhooks for live streaming

When a streaming session detects a breach mid-call, or finishes scoring at the end, CallGuard fires an HMAC-signed POST to your registered webhook URL.

### Configure your webhook

```bash
curl -X PUT "https://app.callguardai.co.uk/v1/api-keys/<your-api-key-id>/webhook" \
  -H "X-API-Key: cg_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_url": "https://your-app.example.com/webhooks/callguard",
    "regenerate_secret": true
  }'
```

The response includes a `webhook_secret` (prefixed `whsec_`). **Store this immediately**. It is shown once and used to verify HMAC signatures on incoming webhook requests.

### Webhook payload shape

CallGuard sends JSON to your endpoint with two custom headers:

```
X-CallGuardAI-Event: session.breach_detected
X-CallGuardAI-Signature: sha256=<hex digest>
User-Agent: CallGuardAI-Webhook/1.0
```

#### `session.breach_detected`

Fires within 30 seconds of a high-confidence breach being detected mid-call.

```json
{
  "event": "session.breach_detected",
  "session_id": "live-session-uuid",
  "external_id": "your-CRM-id",
  "detected_at": "2026-05-06T10:14:53.281Z",
  "breach": {
    "scorecard_item_id": "...",
    "label": "Pressure language",
    "severity": "critical",
    "evidence": "you have to decide right now or this offer's gone",
    "confidence": 0.87
  }
}
```

#### `session.scored`

Fires once when the streaming session ends. Contains the same `result` shape as the polling endpoint above.

```json
{
  "event": "session.scored",
  "session_id": "live-session-uuid",
  "external_id": "your-CRM-id",
  "scored_at": "2026-05-06T10:18:01.918Z",
  "result": {
    "overall_score": 87.5,
    "pass": true,
    "items": [...],
    "breaches": [...],
    "coaching": { ... }
  }
}
```

### Verify the signature

The signature is `sha256=` followed by the hex HMAC-SHA256 of the raw request body, keyed with your `webhook_secret`. Reject any request whose signature does not match.

```js
// Node.js
import crypto from 'crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

```python
# Python
import hmac, hashlib
def verify(raw_body: bytes, signature_header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)
```

### Retries

Failed deliveries (timeout, non-2xx) are retried with exponential backoff up to 6 times over 30 minutes. Each delivery attempt is recorded in the dashboard so you can audit which webhooks landed.

---

## Status codes and error responses

| HTTP | Meaning |
|---|---|
| 200 | OK (or duplicate ingestion) |
| 201 | Resource created |
| 400 | Bad request (validation failure) |
| 401 | Missing or invalid API key |
| 403 | API key revoked, or attempting to access another org's resource |
| 404 | Resource not found |
| 422 | Semantic error (e.g., invalid `scorecard_id`, no active scorecard) |
| 429 | Rate limit exceeded |
| 500 | Server error (please report) |

Error responses follow this shape:

```json
{
  "error": "Bad Request",
  "message": "scorecard_id 8f2a4d2c-... not found for this organization"
}
```

---

## Rate limits

There are no enforced per-key rate limits today. Reasonable use is expected. If you anticipate ingesting more than 100 calls per second sustained, contact us at [hello@callguardai.co.uk](mailto:hello@callguardai.co.uk) and we will provision dedicated capacity.

Bulk-import via the UI is capped at 200 rows per request (split your CSV if larger). Programmatic ingestion via `POST /api/ingestion/calls` has no row cap; just parallelize.

---

## Common integration patterns

### Pattern 1: pull from your dialer's recording archive

A nightly cron job that lists yesterday's recordings, posts each to `/api/ingestion/calls` with your CRM id as `external_id`, then polls `/api/ingestion/calls/:id/result` until each scores. Render the result inside your existing CRM/agent-desktop UI. Keeps CallGuard invisible to your end users.

### Pattern 2: BPO with multiple campaigns

Once a year: list scorecards via `GET /api/ingestion/scorecards`, store the `id` of each campaign-specific scorecard alongside your campaign metadata in your CRM.

Per call: `POST /api/ingestion/calls` with `scorecard_id` set to the right campaign. Tag the call (`tags=client:acme,campaign:q2`) for filtering. Results land in CallGuard's dashboard, scoped to that scorecard.

If you want client-facing reporting per campaign: filter the dashboard by tag, or issue customer share links per call. Full per-client login portal is on our roadmap; talk to us if you need it.

### Pattern 3: live streaming + mid-call alerts

For outbound regulated campaigns where a single bad call is regulator-grade. Mint a session token at the start of each call, stream audio over WebSocket as the dialer connects, register a webhook to receive `session.breach_detected` events to your floor manager's screen or Slack channel. End the session when the dialer disconnects; receive a `session.scored` webhook with the full result.

### Pattern 4: nightly audit-log export

Use the dashboard's `/audit-log/export.csv` endpoint (admin JWT, downloadable from the UI) to pipe an audit trail into your SIEM or compliance archive. Captures every score correction, breach status change, exemplar toggle, API key mint/revoke and bulk import.

---

## Reference: data shapes

### `Call`

```ts
{
  id: string;                 // uuid
  external_id: string | null; // your CRM id, used for dedupe
  status: 'uploaded' | 'transcribing' | 'transcribed' | 'scoring' | 'scored' | 'failed';
  agent_name: string | null;
  call_date: string | null;   // ISO 8601
  duration_seconds: number | null;
  created_at: string;         // ISO 8601
  result: ScoringResult | null;
}
```

### `ScoringResult`

```ts
{
  scorecard_id: string;
  scored_at: string;          // ISO 8601
  overall_score: number;      // 0-100
  pass: boolean;
  items: ScoredItem[];
  breaches: Breach[];
  coaching: Coaching;         // present on Growth and Pro plans
}
```

### `ScoredItem`

```ts
{
  scorecard_item_id: string;
  label: string;              // e.g. "Adviser identity disclosed"
  description: string | null;
  normalized_score: number;   // 0-100
  pass: boolean;              // true when normalized_score >= 70
  evidence: string | null;    // the transcript quote backing the verdict
  reasoning: string | null;   // 1-3 sentences explaining the score
}
```

### `Breach`

```ts
{
  scorecard_item_id: string;
  label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string | null;
}
```

### `Coaching`

```ts
{
  summary: string;            // 2-4 sentence per-call summary
  strengths: string[];
  improvements: string[];
  next_actions: string[];
}
```

---

## Versioning and changelog

This is API version 1. Breaking changes will be communicated 90 days in advance to all customers with active integrations. Additive changes (new optional fields, new endpoints) ship without notice.

| Date | Change |
|---|---|
| 2026-05-06 | Added `scorecard_id` to ingestion + new `GET /api/ingestion/scorecards` endpoint. |
| 2026-05-05 | Added `GET /api/ingestion/calls/:id/result`. |
| 2026-04-28 | Initial public API: `POST /api/ingestion/calls`, API key management, webhook configuration. |

---

## Support

* Product, roadmap or pricing questions: [hello@callguardai.co.uk](mailto:hello@callguardai.co.uk)
* Security or vulnerability reports: [security@callguardai.co.uk](mailto:security@callguardai.co.uk)
* Privacy / DPA / data subject requests: [privacy@callguardai.co.uk](mailto:privacy@callguardai.co.uk)
* Status page and incident communications: dashboard banner + email to admin users on file

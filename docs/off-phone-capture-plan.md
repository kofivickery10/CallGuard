# Off-phone capture: mobile app + meeting platforms

**Status:** proposal, not yet approved
**Date:** 13 August 2026
**Scope:** capturing advice conversations that never touch a dialler — face-to-face
meetings (mobile app) and video meetings on Zoom, Teams and Google Meet.

---

## 1. The one-paragraph version

CallGuard scores telephone conversations. A large share of regulated advice —
mortgage, protection, wealth — is given face to face or over video, and none of it
is currently reachable, which caps how many seats we can sell into any firm that
isn't a phone room. Two capture surfaces close that gap: **server-side connectors
to the meeting platforms' own cloud recordings** (nothing to install, works
retroactively) and **a native mobile app** that records in-person meetings and
uploads them when the adviser is back in signal. Both feed the existing batch
pipeline, which already strips video containers and already scores whatever audio
it is given. The recommended sequence is connectors first, mobile second, live
in-meeting scoring only on demand. Estimated **12–16 dev-weeks** to ship both, and
the business case is seat expansion, not a new SKU: it converts advisers who can
never be a CallGuard seat today into advisers who can.

---

## 2. What already exists

This matters because it materially shortens the build. Three pieces are done:

| Capability | Where | State |
|---|---|---|
| Video container → audio at the ingest boundary | [`services/media.ts`](../packages/api/src/services/media.ts) | **Built.** MP4/MOV/WebM/MKV/AVI up to 500MB, ffmpeg-static (no server install), video track stripped before storage. The file header names Teams/Zoom/Meet as the reason. |
| API ingest of a recording by file or URL | [`routes/ingestion.ts:34`](../packages/api/src/routes/ingestion.ts#L34) | **Built.** `POST /api/ingestion/calls`, API-key auth, multipart `audio` **or** `audio_url`, full metadata (agent, customer, date, external id, scorecard). |
| Live streaming SDK socket | [`routes/stream.ts`](../packages/api/src/routes/stream.ts), [`services/stream-server.ts`](../packages/api/src/services/stream-server.ts), [`services/stream-worker.ts`](../packages/api/src/services/stream-worker.ts) | **Built.** Minted JWT → `/v1/stream/sdk`, binary Opus @16k + JSON control frames, Deepgram live with `redact: ['pci','pii','phi']`, re-score every 30s, breach webhooks, then a `calls` row through normal scoring. Includes a `consent.captured` control frame. |

**A firm can drop a Zoom recording into CallGuard today and it scores.** What does
not exist is getting it there without a human doing it.

### What's missing, precisely

1. **Automatic collection.** No connector to Zoom/Teams/Meet cloud recordings; no
   mobile client.
2. **In-room speaker attribution.** [`services/transcription.ts`](../packages/api/src/services/transcription.ts)
   maps Deepgram clusters to Agent/Customer via a stereo channel pin or a
   "who spoke first + call direction" heuristic. A face-to-face meeting has no
   direction, no channels, and often three people (adviser, client, client's
   partner). **This is the real product problem, not the recording.**
3. **Consent on the record.** `live_sessions` models consent
   (`consent_required` / `consent_captured_at` / `consent_excerpt`, migration 013);
   `calls` has no consent columns at all.
4. **Device authentication.** `mint-token` requires an API key and is explicitly
   server-to-server ([`stream.ts:29`](../packages/api/src/routes/stream.ts#L29)).
   A phone cannot hold an API key.
5. **Upload shape.** Multer is `memoryStorage` with a 500MB ceiling
   ([`middleware/upload.ts`](../packages/api/src/middleware/upload.ts)) — a
   three-hour meeting held entirely in worker RAM, with no resume if the adviser
   walks into a lift.
6. **Streamed sessions keep no audio.** `file_key` points at a `transcript.txt`
   that is never written, `file_size_bytes: 0`, `encrypted_at_rest: false`
   ([`stream-worker.ts:263`](../packages/api/src/services/stream-worker.ts#L263)).
   No playback, no re-transcription, nothing for retention purge to target.
   Pre-existing, but it must be fixed before anything new sits on top of it.
7. **`ingestion_source` is a closed CHECK constraint** — currently
   `upload / api / sftp / live_stream / dialer_webhook`. New sources need a migration.

---

## 3. Architecture options considered

### 3.1 Meeting platforms (Zoom, Teams, Meet)

| Option | How it works | Verdict |
|---|---|---|
| **A. Cloud recording connectors** | Zoom `recording.completed` webhook; Microsoft Graph `callRecords` + recording via Graph/SharePoint; Google Meet API + Drive. Server fetches the file and posts it to the existing `audio_url` ingest. | **Recommended.** Nothing to install, no bot in the room, works retroactively over recordings already made, and reuses the whole batch pipeline. Cost is an OAuth app per platform with tenant admin consent. |
| **B. Bot joins the meeting** | Recall.ai or self-hosted headless Chrome joins as a participant, streams audio into the existing socket. | Later, and only if live in-meeting alerts are asked for. Gets live breaches; a visible participant is arguably better for consent. But self-hosting is a grind and Recall.ai adds a sub-processor to a page we sell on. |
| **C. Native desktop capture** | Electron/Tauri, ScreenCaptureKit (macOS 13+), WASAPI loopback (Windows). | Rejected for now. Most coverage, most work (notarisation, MDM, TCC prompts), and it records *everything* — a governance liability a compliance vendor should not want. |
| **D. Do nothing** | Manual upload already works. | The baseline any of the above must beat. Honest answer for a firm doing two video meetings a week. |

### 3.2 Face-to-face (mobile)

| Option | Verdict |
|---|---|
| **Record-and-upload (batch)** | **Recommended.** Offline-first, resumable. Routes through the *good* pipeline — speaker roles, transcript cleanup, journey assembly, encryption at rest, retention purge. The streaming path skips all of that. |
| **Live streaming from the phone** | Later, if asked for. An adviser in a client's kitchen has no reliable LTE and a dropped WebSocket mid-meeting loses the evidence. |
| **PWA instead of native** | Rejected. iOS Safari kills background audio when the screen locks or a call arrives. This is precisely why Aveni shipped native. Expo/React Native with a background-audio module is the pragmatic build; App Store review will want a written justification for mic + background mode. |

---

## 4. Delivery plan

### Phase 0 — Platform foundations (2–3 weeks)

Shared by both surfaces. Nothing user-visible ships in this phase; everything after
it depends on it.

| Work | Detail |
|---|---|
| Chunked, resumable upload | New endpoint streaming to disk rather than `memoryStorage`; resume by upload id; existing `POST /api/ingestion/calls` kept unchanged for small files and `audio_url`. |
| Consent on `calls` | Migration: `consent_captured_at`, `consent_excerpt`, `consent_method`. Surfaced on CallDetail and in the audit export. |
| Third speaker role | `third_party` alongside Agent/Customer, plus an `in_room` attribution mode in `transcription.ts` and the cleanup pass. Attribution signal: the app has the adviser speak a scripted opener, which doubles as the consent capture. |
| `ingestion_source` values | Migration adding `mobile_app`, `zoom`, `teams`, `meet`. Retention purge and reconciliation updated to cover them. |
| Fix streamed-session audio | Persist the streamed audio to `file_key`, encrypted, with a real `file_size_bytes`. Pre-existing defect; fix before extending. |

**Risk:** in-room attribution is the only genuinely uncertain item. Budget the
extra week here rather than in the app.

### Phase 1 — Meeting platform connectors (3–4 weeks)

| Work | Estimate |
|---|---|
| Zoom (Marketplace app, `recording.completed` webhook, download token, per-tenant OAuth) | ≈1.5 weeks |
| Microsoft Teams (Azure AD app, Graph app permissions, admin consent, recording retrieval) | ≈2 weeks |
| Google Meet (Workspace OAuth, Meet API + Drive fetch) | ≈1.5 weeks |
| Shared: connector settings UI, token refresh, dedupe on external id, backfill job | folded into the above |

Ship Zoom first and validate the whole shape on one platform before building the
other two. Backfill is a genuine selling point: a firm can point us at six months
of existing recordings on day one.

### Phase 2 — Mobile app (6–8 weeks)

| Work | Estimate |
|---|---|
| Expo/React Native shell, auth (user JWT + device registration/revocation) | ≈1.5 weeks |
| Native background recording, crash recovery, local encrypted store | ≈2 weeks |
| Offline upload queue against the Phase 0 chunked endpoint | ≈1 week |
| Consent flow + scripted opener + meeting metadata capture (client, product, attendees) | ≈1 week |
| Adviser-facing review screen (see the meeting scored, listen back) | ≈1 week |
| App Store submission, privacy justification, TestFlight round | ≈1–1.5 weeks |

Android after iOS, or same codebase if Expo modules cooperate — assume iOS-only
for the first release, as Aveni did.

### Phase 3 — Live in-meeting (optional, 3–4 weeks)

Only if a customer specifically asks. Bot-joins-meeting (Recall.ai or self-hosted)
into the existing `/v1/stream/*` socket, plus a user-JWT mint path so a phone can
open a live session directly.

### Totals

| Scenario | Effort |
|---|---|
| Connectors only (Phase 0 + 1) | 5–7 weeks |
| Mobile only (Phase 0 + 2) | 8–11 weeks |
| **Both (Phase 0 + 1 + 2)** | **11–15 weeks** |
| Everything including live | 14–19 weeks |

---

## 5. Business case

### 5.1 The argument in one line

This is **not a new SKU**. It is seat expansion: an adviser who never touches a
dialler cannot be a CallGuard seat today, at any price. Capture converts them into
a billable seat at the same £199/£299/£399.

### 5.2 Worked example

A 40-person regulated advice firm: 12 phone-based staff, 28 advisers who see
clients face to face or over Teams.

| | Sellable seats | Monthly (at £299) | Annual |
|---|---|---|---|
| Today | 12 | £3,588 | £43,056 |
| With off-phone capture | 40 | £11,960 | £143,520 |
| **Delta** | **+28** | **+£8,372** | **+£100,464** |

One firm of this shape pays for the entire build several times over. The same
multiplier applies, smaller, to every mixed-channel firm in the pipeline.

### 5.3 Unit economics

Provider costs from the repo's own pricing tables
([`constants.ts`](../packages/shared/src/constants.ts)): Deepgram nova-3 mono
$0.0086/min (MIP opt-out, no discount — a DPA requirement), Claude Sonnet 5
$3/$15 per 1M tokens, Haiku 4.5 $1/$5, USD→GBP 0.79.

A **45-minute face-to-face meeting**:

| Line | Calculation | USD |
|---|---|---|
| Transcription | 45 min × $0.0086 | $0.387 |
| Transcript cleanup (Haiku) | ≈10k in / ≈10k out | $0.060 |
| Scoring (Sonnet 5) | ≈15k in / ≈4k out | $0.105 |
| **Total per meeting** | | **≈$0.55 (≈£0.44)** |

Per adviser per month, at six meetings a week: **≈$14 (≈£11)**, against a £299
seat. Roughly **4% COGS** — comparable to, and in fact slightly *cheaper* than, a
heavy phone user (40 calls/week × 8 min ≈ $20/month), because long meetings
amortise the fixed LLM cost better than short calls do. Storage adds pennies: a
45-minute MP3 is ≈30MB, encrypted at rest, governed by the existing retention purge.

The meeting-connector path carries the same marginal cost. If we ever adopt a
bot vendor (Phase 3, option B), per-meeting cost rises materially and **needs a
real quote before it enters any pricing model** — I have not assumed a number.

### 5.4 Payback

Charging the build at a notional £4k/week loaded, Phases 0–2 at 13 weeks is
**≈£52k**. At £299/seat that is **174 seat-months** — the 40-person firm above
repays it in **just over six months**, and every subsequent firm is margin.

### 5.5 Competitive position

- **Aveni** ships exactly this: [Aveni Assist](https://apps.apple.com/gb/app/aveni-assist/id6504413491), a free iPhone app that records face-to-face meetings and queues them for upload, with Intelliflo and Xplan integrations. The listing shows 4.6 stars from only five ratings, so the install base looks small — the category is being defined, not won.
- **Callytics** does self-serve data extraction and nothing here.
- **Everyone else in the shortlist** is dialler-only.

Our differentiator remains journey scoring, quote-level evidence and published
pricing. Capture is table stakes we currently lack, not a differentiator — the
correct framing internally is *removing a disqualifier*, not *adding a feature*.

---

## 6. Risks and compliance

| Risk | Response |
|---|---|
| **In-room diarisation is harder than phone** — 3+ speakers, no channels, no direction | Scripted adviser opener as an attribution anchor; `third_party` role; route low-confidence attributions to the existing manual review queue rather than auto-scoring. Same principle already used for consent-gate items. |
| **Bystander capture in a client's home** | DPIA extension before launch. Consent captured in-app, timestamped, with the excerpt stored on the call. Deepgram source-side redaction already applies. |
| **App Store review** | Background audio + microphone need written justification. Budget a rejection round. |
| **Meeting-platform admin consent** | Zoom Marketplace, Azure AD and Google Workspace all need the *customer's* IT to approve. Adds sales friction; mitigate with a one-page install guide per platform. |
| **A firm's recordings live in a US region** | Zoom/Teams/Meet data residency is the customer's setting, not ours. Document it; do not claim UK-only for connector-sourced audio without checking their tenancy. |
| **Scope creep into productivity** | Explicitly out of scope. We are not building fact-find capture or suitability drafting — the compare page already says so in public, and we should keep it true. |

---

## 7. Recommendation

1. **Do Phase 0 + Phase 1 (Zoom first).** Best coverage per unit of work, no
   client to ship, and it lands the "we cover video advice meetings too" claim
   that currently has no answer.
2. **Then Phase 2, mobile, as record-and-upload.** Treat in-room speaker
   attribution as the hard part and the recording as the easy part.
3. **Hold Phase 3 (live) until a customer asks by name.**

## 8. Open decisions

These change the plan and are not mine to make:

- **iOS-only first, or iOS + Android together?** (Aveni is iOS-only. Android adds ≈2 weeks.)
- **Which meeting platform leads?** Plan assumes Zoom; if the pipeline is Microsoft-heavy, lead with Teams and add ≈0.5 weeks.
- **Do we say yes to a bot vendor?** Adding Recall.ai puts a new name on the published sub-processor list — a page we actively sell on.
- **Is capture bundled at all tiers, or Professional and above?** Live streaming is already gated to Professional/Enterprise (`live_streaming` in [`coaching.ts:181`](../packages/shared/src/types/coaching.ts#L181)); capture could follow the same line, or be bundled everywhere to maximise seat conversion. Recommendation: **bundle everywhere** — the point is seat count, and gating it undercuts the entire business case above.

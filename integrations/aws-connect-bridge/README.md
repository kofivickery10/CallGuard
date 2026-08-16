# CallGuard AWS Connect bridge

A single-purpose Lambda that reads an Amazon Connect contact's audio from
Kinesis Video Streams and forwards it to CallGuard's live scoring WebSocket
(the `aws_connect` dialer adapter in
`packages/api/src/services/dialer-adapters.ts`). It runs entirely inside
your own AWS account. Your CallGuard API key lives in Secrets Manager and is
read at invocation time — it is never a CloudFormation parameter or baked
into the deployment package.

Read **"How this actually works"** and **"Known limitations"** below before
you deploy — this integration involves a few genuinely awkward corners of
Amazon Connect + Kinesis Video that are worth understanding rather than
treating as a black box.

## Prerequisites

- An Amazon Connect instance with **live media streaming** available (this
  is a standard Connect capability, no extra enablement needed on AWS's
  side).
- A CallGuard API key with streaming enabled (`allow_streaming = true` on
  the key — ask CallGuard support to turn this on for your org, requires a
  Professional or Enterprise plan) and a WebSocket host to point at.
- Node.js 20.x and `zip` available locally to build the deployment package.
- An S3 bucket in the target region to hold the built package (CloudFormation
  `AWS::Lambda::Function` needs code to come from S3 once you're bundling
  dependencies — this package is too large for the inline-`ZipFile` limit).
- An existing Secrets Manager secret holding your CallGuard API key (create
  this yourself; the template only ever takes its ARN).

## Deploy

1. **Create the secret** (once, outside this template):

   ```bash
   aws secretsmanager create-secret \
     --name callguard/aws-connect-bridge/api-key \
     --secret-string '<your CallGuard API key>' \
     --region <your-region>
   ```

2. **Build the deployment package**:

   ```bash
   cd integrations/aws-connect-bridge
   npm run build   # produces bridge.zip
   ```

3. **Upload it to S3**:

   ```bash
   aws s3 cp bridge.zip s3://<your-bucket>/callguard-aws-connect-bridge/bridge.zip
   ```

4. **Deploy the stack**:

   ```bash
   aws cloudformation deploy \
     --template-file template.yaml \
     --stack-name callguard-aws-connect-bridge \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       CallGuardWebSocketHost=stream.callguardai.co.uk \
       CallGuardApiKeySecretArn=arn:aws:secretsmanager:<region>:<account-id>:secret:callguard/aws-connect-bridge/api-key-XXXXXX \
       ConnectInstanceArn=arn:aws:connect:<region>:<account-id>:instance/<instance-id> \
       KvsStreamArnPattern="arn:aws:kinesisvideo:<region>:<account-id>:stream/*" \
       LambdaCodeS3Bucket=<your-bucket> \
       LambdaCodeS3Key=callguard-aws-connect-bridge/bridge.zip
   ```

   Every value above is something you supply — nothing in the template is
   pre-filled with a CallGuard-owned endpoint, key, or AWS account.
   `KvsStreamArnPattern` must stay wildcarded (`stream/*`) because Connect
   creates a new Kinesis Video Stream per contact; narrow the part after
   `stream/` to your Connect instance's configured stream-name prefix
   (**Data streaming** settings on the instance) if you want tighter IAM
   scoping than "any KVS stream in this account/region".

5. Note the `BridgeFunctionArn` stack output — you'll select it in the
   Contact Flow.

## Wire it into a Contact Flow

1. Add a **Set recording and analytics behavior** block if you want call
   recording alongside streaming (optional, unrelated to this bridge).
2. Add a **Start media streaming** block. This is what actually creates the
   contact's Kinesis Video Stream — nothing works without it. Leave "Track"
   set to stream both the customer and the agent-side audio (the bridge
   expects both; see "Two tracks, downmixed to one" below).
3. Immediately after it, add an **Invoke AWS Lambda function** block and
   select the ARN from the `BridgeFunctionArn` stack output.
4. Set any contact attributes you want CallGuard to see as session metadata
   (queue, product, campaign, etc.) *before* the Invoke Lambda block — the
   bridge forwards whatever is in `Attributes` on the contact at the moment
   it's invoked.
5. Continue the flow as normal (transfer to queue, connect to agent, etc.)
   — you do **not** wait for the Lambda block to return anything
   meaningful. See "Why the flow doesn't wait for the whole call" below;
   this is expected and is how the bridge is designed to work.

## Verify it works

1. Make a test call through the flow.
2. Check the Lambda's CloudWatch Logs (`/aws/lambda/<FunctionName>`, the
   name you deployed with) for lines like `[bridge] not a voice
   ContactFlowEvent` (means the flow didn't reach the Invoke Lambda block
   correctly, or the attributes weren't set) or a clean run with no errors.
3. In the CallGuard dashboard, under **Live sessions** (or the calls list,
   `ingestion_source = live_stream`), confirm a session appears with:
   - `source = aws_connect`
   - `external_id` equal to the Connect `ContactId` from the test call
   - a transcript building up while the call is in progress
4. End the call and confirm it finalises into a scored call record.
5. Deliberately break something (wrong `CallGuardApiKeySecretArn`, or an
   API key without `allow_streaming`) and confirm the Lambda logs a clear
   `401`/`403` from the WebSocket handshake rather than failing silently.

## How this actually works

### The trigger: an "Invoke Lambda" block that doesn't wait for the call to end

Amazon Connect's **Invoke AWS Lambda function** flow block only *waits* a
few seconds for a response before the flow moves on to the next block
(connecting the agent, etc.) — but it does not cancel the underlying Lambda
invocation when it stops waiting. That's what lets a single invocation of
this bridge keep running server-side for the length of the call, well past
however long Connect itself waited for a reply. This isn't a guess: it's
the same mechanism used by AWS's own official reference architecture for
Connect + Kinesis Video,
[`aws-samples/amazon-transcribe-live-call-analytics`](https://github.com/aws-samples/amazon-transcribe-live-call-analytics)
(`lca-connect-kvs-stack`), which this bridge's Kinesis Video / EBML handling
is directly modelled on.

### Kinesis Video is MKV/EBML, and there is no first-class Node parser for it

Amazon Connect doesn't stream to a WebSocket directly — it publishes to
Kinesis Video Streams as Matroska (MKV) fragments, with the raw PCM audio
sitting inside EBML `SimpleBlock` elements. AWS's own "Kinesis Video Stream
Parser Library" is Java-only; there is no equivalent official Node package.

This bridge parses the EBML container itself using
[`ebml-stream`](https://www.npmjs.com/package/ebml-stream), a small, pure-JS,
dependency-free EBML tokenizer (MIT licensed). It reads exactly the elements
needed: `TrackNumber`/`Name` (to map track numbers to Connect's track names),
`SimpleBlock` (the audio payload, tagged with its track number), and the
`AWS_KINESISVIDEO_FRAGMENT_NUMBER` `SimpleTag` (so a resumed read picks up
from the right point). This is the same package and the same technique
AWS's own `amazon-transcribe-live-call-analytics` sample uses in its Node.js
Connect KVS consumer — so this is a credible, precedented approach, not an
improvised one. See `src/kvs-consumer.js` for the implementation and exact
element IDs used.

### Two tracks, downmixed to one

Connect's live media streaming publishes **one** Kinesis Video Stream per
contact containing **two** EBML tracks: `AUDIO_FROM_CUSTOMER` and
`AUDIO_TO_CUSTOMER` (what the customer hears — the agent, plus any IVR/hold
audio before an agent connects). Both are confirmed 16-bit signed PCM,
little-endian, 8kHz, mono, per
[AWS's documented format](https://docs.aws.amazon.com/connect/latest/adminguide/customer-voice-streams.html)
— no re-encoding is needed, only demuxing.

CallGuard's `aws_connect` adapter and `StreamWorker` expect a **single**
mono PCM stream — `packages/api/src/services/stream-worker.ts` hardcodes
`channels: 1` to Deepgram; there's no dual-channel mode on this path. So
this bridge downmixes both tracks into one by summing samples
(`src/pcm-mixer.js`), rather than forwarding only one track (which would
silently drop half the conversation) or interleaving to stereo (which
CallGuard's live-stream adapter has nowhere to put). Both tracks are paired
up in arrival order with a bounded skew tolerance (default 500ms) before a
track that's gone quiet is flushed alone against silence — this is a
reasonable real-time approximation, not timestamp-accurate resampling
against Kinesis Video's producer/server timestamps. It is well within
tolerance for transcription and breach detection.

One direct consequence, already anticipated on the CallGuard side: because
there's no channel-per-speaker split, CallGuard can't pin "Agent" vs
"Customer" the way it can for a real stereo-channel source. It falls back
to Deepgram's speaker-cluster diarization and records a low
`speaker_attribution_confidence` (`UNRELIABLE_SPEAKER_CONFIDENCE` in
`stream-worker.ts`) for every call that comes in this way — which, per that
code's own comments, routes consent-gate checkpoints to manual review
rather than auto-scoring. That's correct and by design on CallGuard's side,
but worth knowing: streamed AWS Connect calls get more manual review volume
than a stereo-channel source would.

### How long calls are handled

Lambda's hard ceiling is 15 minutes. Comfortably before that
(`STOP_BEFORE_TIMEOUT_MS`, default 60s of headroom), the bridge stops
reading new Kinesis Video fragments, flushes the mixer, cleanly ends the
CallGuard session, and — if the call is still going — asynchronously
re-invokes itself with the last successfully-read Kinesis Video fragment
number, so the next invocation resumes reading audio exactly where the
last one left off. No call audio is lost to this mechanism. See "Known
limitations" below for what *does* change when this happens.

## Known limitations

**Read this before quoting resume/continuity claims to a prospect.**

- **A dropped WebSocket does not lose the call, but it does not resume the
  same CallGuard session either.** If the connection to CallGuard drops
  mid-call, the bridge buffers mixed audio (bounded, ~15s default) and
  reconnects with backoff, then opens a **new** session against the same
  `external_id` (the Connect `ContactId`) — see `src/callguard-client.js`.
  CallGuard's server (`stream-server.ts` `onDialerConnection`) creates a
  brand-new `live_sessions` row and a brand-new scored `calls` row on every
  WebSocket connection; it does not today stitch two sessions that share an
  `external_id` back into one call record. So the outcome of a mid-call
  reconnect, or of a call long enough to need a Lambda continuation
  (see above), is **two (or more) separate scored call records tagged with
  the same Connect ContactId**, not one seamlessly resumed transcript. No
  audio and no compliance evidence is lost — it just lands as multiple
  records rather than one.
- **Mixing, not per-speaker channels.** As above — CallGuard sees a downmix
  of both tracks, not a stereo-pinned Agent/Customer split, and treats
  speaker attribution accordingly (lower confidence, more manual review).
- **Contact attributes only, not raw phone numbers.** By default the bridge
  forwards Connect's `Attributes` and queue name as session metadata, not
  `CustomerEndpoint`/`SystemEndpoint` (the raw ANI/DNIS). Uncomment the two
  lines in `src/index.js` (`buildCallContextFromContactFlowEvent`) if your
  org needs phone-number correlation and that's been cleared with your own
  compliance function — this is left off by default rather than assumed.
- **`nodejs20.x` is the Lambda runtime.** It matches this repository's
  Node version. AWS's own runtime deprecation schedule for Node 20 should
  be checked at deploy time; if AWS has retired creation of new `nodejs20.x`
  functions by the time you deploy this, bump `Runtime:` in `template.yaml`
  to a current LTS Node runtime — nothing else in the code depends on a
  specific Node 20 feature.

## Advanced tuning

The template only exposes the environment variables it needs to (see
`Environment.Variables` in `template.yaml`). `src/config.js` reads a few more
with sensible built-in defaults — reconnect backoff/attempt limits and
buffer size (`WS_RECONNECT_*`), and the PCM mixer's skew tolerance
(`MIXER_MAX_SKEW_MS`, `MIXER_FLUSH_INTERVAL_MS`). Override them by adding
environment variables to the deployed function (console, `aws lambda
update-function-configuration`, or by extending `template.yaml`) if the
defaults don't suit your call patterns — most deployments shouldn't need to.

## Files

- `template.yaml` — CloudFormation: the Lambda, its least-privilege IAM
  role (Kinesis Video read scoped to a stream-ARN pattern, CloudWatch Logs
  scoped to its own log group, Secrets Manager read scoped to one secret
  ARN, and self-invoke scoped to itself), and the resource policy letting
  Connect invoke it.
- `src/index.js` — Lambda entrypoint: builds the call context from the
  Contact Flow event (or a continuation event), opens the CallGuard
  session, runs the Kinesis Video consumer, and self-invokes a
  continuation if the call outlives one invocation.
- `src/kvs-consumer.js` — Kinesis Video GetMedia + EBML demuxing.
- `src/pcm-mixer.js` — two-track additive PCM downmix.
- `src/callguard-client.js` — CallGuard WebSocket client: framing, bounded
  reconnect/buffer on drop.
- `src/secrets.js` — Secrets Manager lookup (cached per warm Lambda).
- `src/config.js` — environment variable configuration, all supplied by
  the CloudFormation template.

## Validation performed on this template/code

- `template.yaml`: parsed with a permissive PyYAML loader (confirms valid
  YAML) and validated with `cfn-lint` against the actual CloudFormation
  resource schemas (confirms `AWS::IAM::Role`, `AWS::Lambda::Function`,
  `AWS::Lambda::Permission`, `AWS::Logs::LogGroup` are well-formed and
  correctly wired). `cfn-lint` returns one advisory: `nodejs20.x` is on
  AWS's runtime deprecation schedule — see "Known limitations" above.
  Nothing was deployed and no AWS API was called.
- `src/*.js`: syntax-checked with `node --check`, and `require()`d
  successfully with dependencies installed. `pcm-mixer.js`'s mixing,
  clamping and skew-flush logic was exercised directly against synthetic
  PCM buffers (not against a real Kinesis Video stream — no network calls
  were made).

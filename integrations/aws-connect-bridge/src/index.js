'use strict';

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { getConfig } = require('./config');
const { getCallGuardApiKey } = require('./secrets');
const { consumeKvsStream } = require('./kvs-consumer');
const { CallGuardClient } = require('./callguard-client');

/**
 * Bridges one Amazon Connect contact's Kinesis Video Stream audio to
 * CallGuard's live scoring WebSocket (aws_connect adapter). See README.md
 * for the full picture — this comment covers only how the Lambda gets
 * invoked and kept running past its own timeout, which is the part that
 * looks odd in isolation.
 *
 * TRIGGER: a Contact Flow's "Start media streaming" block (which creates
 * the Kinesis Video Stream) followed by an "Invoke AWS Lambda function"
 * block naming this function. Amazon Connect's flow block only WAITS for a
 * response for a few seconds before moving on to the next flow block
 * (agent connect, etc.) on timeout — but the underlying Lambda invocation
 * is not cancelled when Connect stops waiting for it. That's what lets a
 * single invocation run for the length of the call. This is not a guess:
 * it is the same mechanism AWS's own official sample uses
 * (aws-samples/amazon-transcribe-live-call-analytics,
 * lca-connect-kvs-stack), which we drew on directly for the Kinesis Video
 * EBML handling in kvs-consumer.js.
 *
 * CONTINUATION: Lambda's hard ceiling is 15 minutes. Comfortably before
 * that (config.stopBeforeTimeoutMs), consumeKvsStream() stops reading new
 * fragments, the mixer is flushed, the CallGuard session is cleanly ended,
 * and — if the call is still going — this function asynchronously
 * re-invokes itself (event.action = 'LAMBDA_CONTINUE') carrying the last
 * Kinesis Video fragment number, so the next invocation resumes reading
 * audio exactly where this one left off. IMPORTANT: that continuation
 * opens a NEW CallGuard session under the same external_id (the Connect
 * ContactId) — CallGuard does not stitch sessions back together, so a call
 * that runs long enough to need a continuation becomes two (or more)
 * scored call records in CallGuard, not one. See README.md
 * "Known limitations".
 */
exports.handler = async function handler(event, context) {
  const config = getConfig();

  let callContext;
  if (event.action === 'LAMBDA_CONTINUE') {
    callContext = event.callContext;
    console.log(`[bridge] continuing external_id=${callContext.externalId}, invocation #${callContext.invocationCount}`);
    if (callContext.invocationCount > 40) {
      // ~40 * 14 minutes ≈ 9 hours. A real call is never this long; this is
      // a guard against a runaway self-invoke loop, not a real limit.
      console.error('[bridge] refusing to continue - too many chained invocations, stopping.');
      return;
    }
  } else {
    callContext = buildCallContextFromContactFlowEvent(event, config);
    if (!callContext) return; // logged inside; not a voice contact or wrong instance
  }

  const apiKey = await getCallGuardApiKey(config.apiKeySecretArn);

  const cgClient = new CallGuardClient({
    wsHost: config.callguardWsHost,
    apiKey,
    externalId: callContext.externalId,
    metadata: callContext.metadata,
    config,
  });

  await cgClient.connect();

  let result;
  try {
    result = await consumeKvsStream({
      streamArn: callContext.streamArn,
      afterFragmentNumber: callContext.lastFragmentNumber || undefined,
      mixerConfig: {
        sampleRate: config.sampleRate,
        maxSkewMs: config.mixerMaxSkewMs,
        flushIntervalMs: config.mixerFlushIntervalMs,
      },
      onMixedAudio: (buf) => cgClient.sendAudio(buf),
      getRemainingTimeMs: () => context.getRemainingTimeInMillis(),
      stopBeforeTimeoutMs: config.stopBeforeTimeoutMs,
    });
  } finally {
    await cgClient.end();
  }

  if (result.endedNaturally) {
    console.log(`[bridge] call ended naturally, external_id=${callContext.externalId}`);
    return;
  }

  console.warn(
    `[bridge] approaching Lambda timeout, self-invoking continuation for external_id=${callContext.externalId}`,
  );
  const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: context.invokedFunctionArn,
      InvocationType: 'Event',
      Payload: Buffer.from(
        JSON.stringify({
          action: 'LAMBDA_CONTINUE',
          callContext: {
            ...callContext,
            lastFragmentNumber: result.lastFragmentNumber,
            invocationCount: (callContext.invocationCount || 1) + 1,
          },
        }),
      ),
    }),
  );
};

/**
 * Builds the call context from the standard payload Amazon Connect sends
 * when a Contact Flow's "Invoke AWS Lambda function" block calls this
 * function. Forwards contact attributes as metadata (whatever the flow
 * author has chosen to set on the contact - queue, product, campaign,
 * etc.), and the queue name - deliberately does NOT forward the raw
 * customer/system phone numbers by default, since CallGuard's own PII
 * posture is to keep numbers out of anything that isn't already
 * source-redacted audio/transcript. Uncomment below if your org has a
 * specific need to correlate on ANI and has cleared that with compliance.
 */
function buildCallContextFromContactFlowEvent(event, config) {
  if (event.Name !== 'ContactFlowEvent' || event.Details?.ContactData?.Channel !== 'VOICE') {
    console.log('[bridge] not a voice ContactFlowEvent invocation, ignoring:', JSON.stringify(event).slice(0, 500));
    return null;
  }

  const contactData = event.Details.ContactData;

  if (config.connectInstanceArn && contactData.InstanceARN !== config.connectInstanceArn) {
    console.error(
      `[bridge] refusing to process contact from unexpected instance ${contactData.InstanceARN}`,
    );
    return null;
  }

  const streamArn = contactData.MediaStreams?.Customer?.Audio?.StreamARN;
  if (!streamArn) {
    console.error('[bridge] no MediaStreams.Customer.Audio.StreamARN on contact - was "Start media streaming" run first in the flow?');
    return null;
  }

  return {
    externalId: contactData.ContactId,
    streamArn,
    lastFragmentNumber: null,
    invocationCount: 1,
    metadata: {
      queue_name: contactData.Queue?.Name,
      initial_contact_id: contactData.InitialContactId,
      channel: contactData.Channel,
      instance_arn: contactData.InstanceARN,
      attributes: contactData.Attributes || {},
      // fromNumber: contactData.CustomerEndpoint?.Address,
      // toNumber: contactData.SystemEndpoint?.Address,
    },
  };
}

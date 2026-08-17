'use strict';

const { KinesisVideoClient, GetDataEndpointCommand } = require('@aws-sdk/client-kinesis-video');
const { KinesisVideoMedia } = require('@aws-sdk/client-kinesis-video-media');
const { EbmlStreamDecoder, EbmlTagId } = require('ebml-stream');
const { PcmMixer, TRACK_A, TRACK_B } = require('./pcm-mixer');

/**
 * Reads an Amazon Connect Kinesis Video Stream and demuxes it into mixed
 * mono PCM.
 *
 * Amazon Connect's live media streaming publishes ONE Kinesis Video Stream
 * per contact (the ARN comes from
 * event.Details.ContactData.MediaStreams.Customer.Audio.StreamARN in the
 * Contact Flow's Lambda invocation) containing TWO Matroska/EBML tracks in
 * the same stream: "AUDIO_FROM_CUSTOMER" and "AUDIO_TO_CUSTOMER", each raw
 * PCM 16-bit signed little-endian, 8kHz, mono
 * (https://docs.aws.amazon.com/connect/latest/adminguide/customer-voice-streams.html).
 *
 * There is no first-class Node.js parser for this from AWS (their
 * "Kinesis Video Stream Parser Library" is Java-only). This module instead
 * tokenizes the generic EBML container format with the `ebml-stream`
 * package and reads the Matroska elements we need directly — TrackNumber /
 * Name (to build a track-number -> track-name map), SimpleBlock (the actual
 * audio payload, tagged with its track number), and the
 * AWS_KINESISVIDEO_FRAGMENT_NUMBER SimpleTag (so a dropped/continued read
 * can resume from the right point). This is the same package and the same
 * technique AWS's own official sample for Connect + Kinesis Video uses in
 * Node.js — see aws-samples/amazon-transcribe-live-call-analytics,
 * lca-connect-kvs-stack/lambda_functions/connect_kvs_consumer — which
 * confirms this is a credible, production-precedented approach in
 * JavaScript, not an experimental one.
 */

const FRAGMENT_NUMBER_TAG = 'AWS_KINESISVIDEO_FRAGMENT_NUMBER';

/**
 * @param {object} opts
 * @param {string} opts.streamArn
 * @param {string} [opts.afterFragmentNumber] - resume point for a continuation
 * @param {object} opts.mixerConfig - { sampleRate, maxSkewMs, flushIntervalMs }
 * @param {(mixed: Buffer) => void} opts.onMixedAudio
 * @param {() => number} opts.getRemainingTimeMs - Lambda context.getRemainingTimeInMillis
 * @param {number} opts.stopBeforeTimeoutMs
 * @returns {Promise<{ endedNaturally: boolean, lastFragmentNumber: string|null }>}
 */
async function consumeKvsStream({
  streamArn,
  afterFragmentNumber,
  mixerConfig,
  onMixedAudio,
  getRemainingTimeMs,
  stopBeforeTimeoutMs,
}) {
  const region = streamArn.split(':')[3];
  const kvClient = new KinesisVideoClient({ region });
  const endpointResponse = await kvClient.send(
    new GetDataEndpointCommand({ APIName: 'GET_MEDIA', StreamARN: streamArn }),
  );
  const mediaClient = new KinesisVideoMedia({ region, endpoint: endpointResponse.DataEndpoint });

  const startSelector = afterFragmentNumber
    ? { StartSelectorType: 'FRAGMENT_NUMBER', AfterFragmentNumber: afterFragmentNumber }
    : { StartSelectorType: 'NOW' };

  const mediaResponse = await mediaClient.getMedia({ StreamARN: streamArn, StartSelector: startSelector });
  const payloadStream = mediaResponse.Payload;

  const trackNames = {}; // trackNumber -> "AUDIO_FROM_CUSTOMER" | "AUDIO_TO_CUSTOMER"
  let currentTrackNumber = null;
  let lastFragmentNumber = afterFragmentNumber || null;
  let timedOut = false;

  const mixer = new PcmMixer({
    sampleRate: mixerConfig.sampleRate,
    maxSkewMs: mixerConfig.maxSkewMs,
    onMixed: onMixedAudio,
  });
  const skewTimer = setInterval(() => mixer.flushSkew(), mixerConfig.flushIntervalMs);

  const decoder = new EbmlStreamDecoder({
    bufferTagIds: [EbmlTagId.SimpleTag, EbmlTagId.SimpleBlock],
  });

  decoder.on('error', (err) => {
    console.error('[kvs-consumer] EBML decode error:', err.message || err);
  });

  decoder.on('data', (tag) => {
    if (tag.id === EbmlTagId.TrackNumber) {
      // TrackNumber is an EBML UnsignedInt element - ebml-stream already
      // decodes it to a JS Number (see EbmlDataTag.parseContent).
      currentTrackNumber = Number(tag.data);
      return;
    }
    if (tag.id === EbmlTagId.Name && currentTrackNumber !== null) {
      trackNames[currentTrackNumber] = tag.data.toString();
      return;
    }
    if (tag.id === EbmlTagId.SimpleTag && tag.Children && tag.Children.length >= 2) {
      const tagName = tag.Children[0] && tag.Children[0].data;
      const tagValue = tag.Children[1] && tag.Children[1].data;
      if (tagName === FRAGMENT_NUMBER_TAG && tagValue) {
        lastFragmentNumber = tagValue.toString();
      }
      return;
    }
    if (tag.id === EbmlTagId.SimpleBlock) {
      const trackName = trackNames[tag.track];
      if (trackName === TRACK_A || trackName === TRACK_B) {
        mixer.push(trackName, tag.payload);
      }
    }
  });

  try {
    for await (const chunk of payloadStream) {
      decoder.write(chunk);

      if (getRemainingTimeMs() < stopBeforeTimeoutMs) {
        timedOut = true;
        break;
      }
    }
  } finally {
    clearInterval(skewTimer);
    decoder.end();
    mixer.flushAll();
    if (typeof payloadStream.destroy === 'function') {
      payloadStream.destroy();
    }
  }

  return { endedNaturally: !timedOut, lastFragmentNumber };
}

module.exports = { consumeKvsStream };

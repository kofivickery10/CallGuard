'use strict';

/**
 * Downmixes Amazon Connect's two audio tracks — AUDIO_FROM_CUSTOMER and
 * AUDIO_TO_CUSTOMER (which carries the agent, plus any IVR/hold audio the
 * customer hears before an agent connects) — into a single mono PCM stream.
 *
 * Why mixing, not picking one track or interleaving to stereo: CallGuard's
 * aws_connect adapter (packages/api/src/services/dialer-adapters.ts) and its
 * StreamWorker (packages/api/src/services/stream-worker.ts, which hardcodes
 * `channels: 1` on the Deepgram session) both expect a single mono PCM
 * stream — there is no dual-channel mode on this path. Sending only one
 * track would silently drop one side of the conversation, which is
 * unacceptable for a compliance product. So both tracks are summed,
 * sample-by-sample, into one channel and Deepgram's speaker-cluster
 * diarization does the job of telling the two speakers apart afterwards —
 * exactly the "no stereo-channel pin" path StreamWorker.finalize() already
 * accounts for by writing UNRELIABLE_SPEAKER_CONFIDENCE for live-streamed
 * calls. This is an approximation, not timestamp-accurate resampling
 * against Kinesis Video's producer/server timestamps: two tracks are paired
 * up in arrival order, sample-for-sample, tolerating up to `maxSkewMs` of
 * drift between them before a track is flushed alone (silence standing in
 * for the other side). That is well within tolerance for transcription and
 * breach detection, but it is not broadcast-grade audio mixing.
 */

const TRACK_A = 'AUDIO_FROM_CUSTOMER';
const TRACK_B = 'AUDIO_TO_CUSTOMER';

class PcmMixer {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate
   * @param {number} opts.maxSkewMs - max amount one track may lead the other by before we flush it alone
   * @param {(mixed: Buffer) => void} opts.onMixed - called with mixed mono PCM16LE chunks, in order
   */
  constructor({ sampleRate, maxSkewMs, onMixed }) {
    this.sampleRate = sampleRate;
    this.maxSkewSamples = Math.round((maxSkewMs / 1000) * sampleRate);
    this.onMixed = onMixed;
    this.buffers = {
      [TRACK_A]: Buffer.alloc(0),
      [TRACK_B]: Buffer.alloc(0),
    };
    this.closed = false;
  }

  /** Feed raw PCM16LE bytes for one track (as extracted from an EBML SimpleBlock). */
  push(trackName, chunk) {
    if (this.closed || !chunk || chunk.length === 0) return;
    if (trackName !== TRACK_A && trackName !== TRACK_B) return;
    this.buffers[trackName] = Buffer.concat([this.buffers[trackName], chunk]);
    this._drainPaired();
  }

  /** Mix whatever is fully paired between the two tracks. */
  _drainPaired() {
    const a = this.buffers[TRACK_A];
    const b = this.buffers[TRACK_B];
    const pairedSamples = Math.min(a.length, b.length) >> 1; // whole 16-bit samples
    if (pairedSamples === 0) return;

    const pairedBytes = pairedSamples * 2;
    const mixed = Buffer.alloc(pairedBytes);
    for (let i = 0; i < pairedBytes; i += 2) {
      const sampleA = a.readInt16LE(i);
      const sampleB = b.readInt16LE(i);
      mixed.writeInt16LE(clampInt16(sampleA + sampleB), i);
    }

    this.buffers[TRACK_A] = a.subarray(pairedBytes);
    this.buffers[TRACK_B] = b.subarray(pairedBytes);
    this.onMixed(mixed);
  }

  /**
   * Called on a timer (see kvs-consumer.js) so a track that has gone quiet
   * (e.g. no agent connected yet, or the customer stopped talking) doesn't
   * hold up the other track's audio indefinitely. Any samples on the
   * further-ahead track beyond the skew tolerance are flushed against
   * silence on the other side.
   */
  flushSkew() {
    const a = this.buffers[TRACK_A];
    const b = this.buffers[TRACK_B];
    const skewBytes = this.maxSkewSamples * 2;

    if (a.length > b.length + skewBytes) {
      this._flushAlone(TRACK_A, a.length - b.length - skewBytes);
    } else if (b.length > a.length + skewBytes) {
      this._flushAlone(TRACK_B, b.length - a.length - skewBytes);
    }
  }

  _flushAlone(track, excessBytes) {
    const evenExcessBytes = excessBytes - (excessBytes % 2);
    if (evenExcessBytes <= 0) return;
    const buf = this.buffers[track];
    const chunk = buf.subarray(0, evenExcessBytes);
    this.buffers[track] = buf.subarray(evenExcessBytes);
    // Pass through as-is: mixing with silence is a no-op sum, so just emit it.
    this.onMixed(Buffer.from(chunk));
  }

  /** Flush everything remaining (call on session end) so no trailing audio is lost. */
  flushAll() {
    this._drainPaired();
    const a = this.buffers[TRACK_A];
    const b = this.buffers[TRACK_B];
    if (a.length > 0) this._flushAlone(TRACK_A, a.length);
    if (b.length > 0) this._flushAlone(TRACK_B, b.length);
    this.closed = true;
  }
}

function clampInt16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

module.exports = { PcmMixer, TRACK_A, TRACK_B };

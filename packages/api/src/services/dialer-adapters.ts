import type { LiveSessionSource } from '@callguard/shared';

/**
 * Dialer adapters translate vendor-specific WebSocket frame formats into a
 * normalized shape the StreamWorker can consume.
 *
 * Each adapter exposes:
 *   - parseFrame(data): returns either an audio chunk, a control event, or null
 *   - audioFormat / sampleRate descriptors used to configure Deepgram
 */

export type AdapterEvent =
  | { kind: 'audio'; audio: Buffer }
  | { kind: 'session_start'; metadata: Record<string, unknown>; externalId?: string }
  | { kind: 'session_end' }
  | { kind: 'ignore' };

export interface DialerAdapter {
  source: LiveSessionSource;
  audioFormat: 'opus' | 'linear16' | 'mulaw';
  sampleRate: number;
  parseFrame: (raw: string | Buffer) => AdapterEvent;
}

// ─── Twilio Media Streams ────────────────────────────────────────────────
// Frames are JSON only. Audio is μ-law 8kHz mono base64-encoded.
// https://www.twilio.com/docs/voice/media-streams/websocket-messages

interface TwilioFrame {
  event: 'connected' | 'start' | 'media' | 'stop' | 'mark';
  start?: {
    streamSid?: string;
    callSid?: string;
    customParameters?: Record<string, string>;
    mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
  };
  media?: { payload: string };
  stop?: unknown;
}

export const twilioAdapter: DialerAdapter = {
  source: 'twilio',
  audioFormat: 'mulaw',
  sampleRate: 8000,
  parseFrame: (raw) => {
    if (Buffer.isBuffer(raw)) return { kind: 'ignore' };
    let frame: TwilioFrame;
    try {
      frame = JSON.parse(raw) as TwilioFrame;
    } catch {
      return { kind: 'ignore' };
    }
    if (frame.event === 'media' && frame.media?.payload) {
      return { kind: 'audio', audio: Buffer.from(frame.media.payload, 'base64') };
    }
    if (frame.event === 'start') {
      return {
        kind: 'session_start',
        metadata: frame.start?.customParameters || {},
        externalId: frame.start?.callSid,
      };
    }
    if (frame.event === 'stop') {
      return { kind: 'session_end' };
    }
    return { kind: 'ignore' };
  },
};

// ─── AWS Connect ─────────────────────────────────────────────────────────
// AWS Connect natively streams via Kinesis Video. Partners typically run a
// small Lambda bridge that re-emits over WebSocket using our generic
// protocol. PCM 16-bit 8kHz mono per AWS Connect spec.

export const awsConnectAdapter: DialerAdapter = {
  source: 'aws_connect',
  audioFormat: 'linear16',
  sampleRate: 8000,
  parseFrame: (raw) => {
    if (Buffer.isBuffer(raw)) {
      return { kind: 'audio', audio: raw };
    }
    let frame: { event?: string; metadata?: Record<string, unknown>; external_id?: string };
    try {
      frame = JSON.parse(raw);
    } catch {
      return { kind: 'ignore' };
    }
    if (frame.event === 'session.start') {
      return {
        kind: 'session_start',
        metadata: frame.metadata || {},
        externalId: frame.external_id,
      };
    }
    if (frame.event === 'session.end') {
      return { kind: 'session_end' };
    }
    return { kind: 'ignore' };
  },
};

// ─── Generic dialer ──────────────────────────────────────────────────────
// Same protocol as the mobile SDK. Audio is binary frames; control is JSON.
// Defaults to Opus 16kHz - partner can override via session.start frame.

export const genericAdapter: DialerAdapter = {
  source: 'generic_dialer',
  audioFormat: 'opus',
  sampleRate: 16000,
  parseFrame: (raw) => {
    if (Buffer.isBuffer(raw)) {
      return { kind: 'audio', audio: raw };
    }
    let frame: { type?: string; metadata?: Record<string, unknown>; external_id?: string };
    try {
      frame = JSON.parse(raw);
    } catch {
      return { kind: 'ignore' };
    }
    if (frame.type === 'session.start') {
      return {
        kind: 'session_start',
        metadata: frame.metadata || {},
        externalId: frame.external_id,
      };
    }
    if (frame.type === 'session.end') {
      return { kind: 'session_end' };
    }
    return { kind: 'ignore' };
  },
};

export const ADAPTERS: Record<string, DialerAdapter> = {
  twilio: twilioAdapter,
  'aws-connect': awsConnectAdapter,
  aws_connect: awsConnectAdapter,
  generic: genericAdapter,
};

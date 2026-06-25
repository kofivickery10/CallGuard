import { createClient, LiveTranscriptionEvents, type LiveClient } from '@deepgram/sdk';
import { config } from '../config.js';

export interface DeepgramStreamCallbacks {
  onTranscript: (text: string, speaker: number | null, isFinal: boolean) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export interface DeepgramStreamOptions {
  encoding: 'opus' | 'linear16' | 'mulaw';
  sampleRate: number;
  channels?: number;
  keyterms?: string[];
}

/**
 * Wraps Deepgram's live transcription WebSocket.
 * Handles audio frame forwarding and partial/final transcript events.
 */
export class DeepgramStream {
  private connection: LiveClient | null = null;
  private closed = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: DeepgramStreamOptions,
    private readonly callbacks: DeepgramStreamCallbacks,
  ) {}

  start(): void {
    if (!config.deepgram.apiKey) {
      throw new Error('DEEPGRAM_API_KEY not set - required for live streaming');
    }

    const client = createClient(config.deepgram.apiKey, {
      global: { url: config.deepgram.baseUrl },
    });

    this.connection = client.listen.live({
      model: 'nova-3',
      // Opt out of Deepgram's Model Improvement Program (no training on call audio).
      mip_opt_out: true,
      language: 'en-GB',
      smart_format: true,
      punctuate: true,
      interim_results: true,
      diarize: true,
      // Redact PII/PCI/PHI at source (streaming redaction is English-only, which
      // matches en-GB). Customers' personal/payment/health data is replaced with
      // typed tags before any transcript reaches our store or the LLM scorer.
      // Note: we deliberately do not set no_delay, which would trade redaction
      // accuracy for latency.
      redact: ['pci', 'pii', 'phi'],
      encoding: this.opts.encoding,
      sample_rate: this.opts.sampleRate,
      channels: this.opts.channels ?? 1,
      keyterm: this.opts.keyterms,
    });

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      // Deepgram requires periodic keep-alive when audio is sparse
      this.keepAliveTimer = setInterval(() => {
        try {
          this.connection?.keepAlive();
        } catch {
          // Connection already gone — ignore
        }
      }, 8000);
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
      const event = data as {
        is_final?: boolean;
        channel?: {
          alternatives?: Array<{
            transcript?: string;
            words?: Array<{ speaker?: number }>;
          }>;
        };
      };
      const alt = event.channel?.alternatives?.[0];
      const text = alt?.transcript;
      if (!text) return;
      const speaker = alt?.words?.[0]?.speaker ?? null;
      this.callbacks.onTranscript(text, speaker, Boolean(event.is_final));
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    });

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      this.cleanupKeepAlive();
      if (!this.closed) {
        this.callbacks.onClose();
      }
    });
  }

  /** Forward an audio chunk to Deepgram. */
  send(audio: Buffer): void {
    if (this.closed || !this.connection) return;
    try {
      // Deepgram SDK accepts ArrayBuffer/Blob; copy the Buffer's exact slice
      const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
      this.connection.send(ab);
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanupKeepAlive();
    try {
      this.connection?.finish();
    } catch {
      // ignore
    }
  }

  private cleanupKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}

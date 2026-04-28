import type { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { query, queryOne } from '../db/client.js';
import { DeepgramStream } from './deepgram-stream.js';
import { detectLiveBreaches } from './live-scorer.js';
import { deliverWebhook } from './webhook-delivery.js';
import { getKBContext } from './kb.js';
import { scoringQueue } from '../jobs/queue.js';
import type {
  LiveSessionSource,
  ServerFrame,
  ClientControlFrame,
} from '@callguard/shared';

interface StreamWorkerInit {
  sessionId: string;
  organizationId: string;
  apiKeyId: string;
  source: LiveSessionSource;
  externalId: string | null;
  agentId: string | null;
  scorecardId: string | null;
  audioFormat: 'opus' | 'linear16' | 'mulaw';
  audioSampleRate: number;
  metadata: Record<string, unknown>;
  consentRequired: boolean;
  client: WebSocket;
}

const LIVE_SCORING_INTERVAL_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * Owns the lifecycle of one live streaming session:
 *  - holds the client WebSocket
 *  - holds the Deepgram WebSocket
 *  - accumulates the rolling transcript
 *  - periodically asks the live scorer for new breaches
 *  - emits transcript / breach events to client and webhook
 *  - on session.end: persists the call, kicks off the standard scoring pipeline,
 *    and delivers the final webhook once final scoring completes
 */
export class StreamWorker {
  private dg: DeepgramStream;
  private rollingTranscript: string[] = [];
  private finalSegments: string[] = [];
  private emittedItemIds = new Set<string>();
  private liveScoringTimer: NodeJS.Timeout | null = null;
  private liveScoringInFlight = false;
  private kbContext: string | null = null;
  private scorecardItemsCache: Awaited<ReturnType<typeof loadScorecardItems>> | null = null;
  private startedAt = new Date();
  private endedAt: Date | null = null;
  private clientClosed = false;

  constructor(private readonly init: StreamWorkerInit) {
    this.dg = new DeepgramStream(
      {
        encoding: init.audioFormat,
        sampleRate: init.audioSampleRate,
        channels: 1,
      },
      {
        onTranscript: (text, speaker, isFinal) => this.onDeepgramTranscript(text, speaker, isFinal),
        onError: (err) => {
          console.error(`[Stream ${init.sessionId}] Deepgram error:`, err.message);
          this.sendToClient({ type: 'error', message: 'Transcription error', code: 'DEEPGRAM_ERROR' });
        },
        onClose: () => {
          // Deepgram closed - if session is still active this is unexpected
          if (!this.endedAt) {
            console.warn(`[Stream ${init.sessionId}] Deepgram closed unexpectedly`);
          }
        },
      },
    );
  }

  async start(): Promise<void> {
    await query(
      `UPDATE live_sessions
          SET status = 'active', started_at = now()
        WHERE id = $1`,
      [this.init.sessionId],
    );

    this.dg.start();

    this.sendToClient({ type: 'ack', session_id: this.init.sessionId });

    this.liveScoringTimer = setInterval(() => {
      void this.runLiveScoringPass();
    }, LIVE_SCORING_INTERVAL_MS);
  }

  /** Forward an audio chunk to Deepgram. */
  ingestAudio(audio: Buffer): void {
    if (this.endedAt) return;
    this.dg.send(audio);
  }

  /** Handle a non-audio control frame from the client. */
  async ingestControlFrame(frame: ClientControlFrame): Promise<void> {
    switch (frame.type) {
      case 'session.start':
        // Already handled at connect time; ignore duplicates
        break;
      case 'consent.captured':
        await query(
          `UPDATE live_sessions
              SET consent_captured_at = now(), consent_excerpt = $2
            WHERE id = $1`,
          [this.init.sessionId, frame.transcript_excerpt || null],
        );
        break;
      case 'ping':
        this.sendToClient({ type: 'pong' });
        break;
      case 'session.end':
        await this.finalize();
        break;
    }
  }

  /** Called when client WebSocket closes (graceful or otherwise). */
  async handleClientClose(): Promise<void> {
    this.clientClosed = true;
    if (!this.endedAt) {
      await this.finalize();
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private onDeepgramTranscript(text: string, speaker: number | null, isFinal: boolean): void {
    if (isFinal) {
      const labelled = speaker != null ? `[Speaker ${speaker}] ${text}` : text;
      this.finalSegments.push(labelled);
      if (this.totalTranscriptLength() > MAX_TRANSCRIPT_CHARS) {
        // Cap transcript to avoid runaway memory on multi-hour sessions
        while (this.totalTranscriptLength() > MAX_TRANSCRIPT_CHARS && this.finalSegments.length > 1) {
          this.finalSegments.shift();
        }
      }
    }
    this.rollingTranscript = isFinal ? [] : [text];

    this.sendToClient({
      type: 'transcript.partial',
      text,
      speaker,
      is_final: isFinal,
      ts: new Date().toISOString(),
    });
  }

  private async runLiveScoringPass(): Promise<void> {
    if (this.liveScoringInFlight || this.endedAt) return;
    this.liveScoringInFlight = true;
    try {
      const items = await this.getScorecardItems();
      if (!items || items.length === 0) return;

      const remaining = items.filter((i) => !this.emittedItemIds.has(i.id));
      if (remaining.length === 0) return;

      const transcript = this.currentTranscript();
      if (transcript.trim().length < 80) return;

      const kbContext = await this.getKBContext();

      const breaches = await detectLiveBreaches({
        partialTranscript: transcript,
        scorecardItems: items,
        alreadyEmittedItemIds: this.emittedItemIds,
        kbContext,
      });

      for (const b of breaches) {
        this.emittedItemIds.add(b.scorecard_item_id);

        // Persist that we emitted this breach
        await query(
          `INSERT INTO live_session_emitted_breaches
             (session_id, scorecard_item_id, severity, evidence)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id, scorecard_item_id) DO NOTHING`,
          [this.init.sessionId, b.scorecard_item_id, b.severity, b.evidence],
        );

        const ts = new Date().toISOString();

        this.sendToClient({
          type: 'breach.detected',
          scorecard_item_id: b.scorecard_item_id,
          scorecard_item_label: b.scorecard_item_label,
          severity: b.severity,
          evidence: b.evidence,
          ts,
        });

        // Fire webhook (best-effort, don't block)
        deliverWebhook(this.init.apiKeyId, this.init.sessionId, {
          event: 'session.breach_detected',
          session_id: this.init.sessionId,
          external_id: this.init.externalId,
          ts,
          severity: b.severity,
          scorecard_item_id: b.scorecard_item_id,
          scorecard_item_label: b.scorecard_item_label,
          evidence: b.evidence,
        }).catch((err) => {
          console.error(`[Stream ${this.init.sessionId}] Webhook delivery error:`, err);
        });
      }
    } catch (err) {
      console.error(`[Stream ${this.init.sessionId}] Live scoring failed:`, (err as Error).message);
    } finally {
      this.liveScoringInFlight = false;
    }
  }

  private async finalize(): Promise<void> {
    if (this.endedAt) return;
    this.endedAt = new Date();

    if (this.liveScoringTimer) {
      clearInterval(this.liveScoringTimer);
      this.liveScoringTimer = null;
    }

    this.dg.finish();

    const finalTranscript = this.currentTranscript();
    const durationSec = Math.round((this.endedAt.getTime() - this.startedAt.getTime()) / 1000);

    // Persist transcript on the session
    await query(
      `UPDATE live_sessions
          SET status = 'ended', ended_at = now(), duration_seconds = $2, transcript_text = $3
        WHERE id = $1`,
      [this.init.sessionId, durationSec, finalTranscript],
    );

    let callId: string | null = null;

    if (finalTranscript.trim().length >= 80 && this.init.scorecardId) {
      // Create a calls row from the streamed session and route it through the
      // standard scoring pipeline. The scoring worker handles everything from
      // here: scoring, breach insertion, alert evaluation, exemplar tagging.
      const callRow = await queryOne<{ id: string }>(
        `INSERT INTO calls (
            id, organization_id, uploaded_by, file_name, file_key,
            file_size_bytes, mime_type, agent_id, agent_name,
            duration_seconds, status, transcript_text,
            ingestion_source, encrypted_at_rest, external_id
          )
          VALUES ($1, $2, NULL, $3, $4, 0, 'audio/stream', $5,
                  (SELECT name FROM users WHERE id = $5),
                  $6, 'transcribing', $7, 'live_stream', false, $8)
          RETURNING id`,
        [
          uuid(),
          this.init.organizationId,
          `live-${this.init.sessionId.slice(0, 8)}.stream`,
          `live/${this.init.organizationId}/${this.init.sessionId}/transcript.txt`,
          this.init.agentId,
          durationSec,
          finalTranscript,
          this.init.externalId,
        ],
      );
      callId = callRow!.id;

      await query(
        `UPDATE live_sessions SET final_call_id = $2 WHERE id = $1`,
        [this.init.sessionId, callId],
      );

      // Skip the transcription queue (we already have the transcript) - go straight to scoring.
      // The scoring processor expects the call to be at status='scored' or earlier; bumping
      // to 'scoring' is what processScoring does on entry, so leaving as 'transcribing' here.
      await query(
        `UPDATE calls SET status = 'transcribed', updated_at = now() WHERE id = $1`,
        [callId],
      );

      await scoringQueue.add('score-streamed-call', { callId });
    }

    if (callId && this.init.externalId !== null) {
      // Final webhook fires from a one-shot follower that polls until scoring completes.
      // For v1 simplicity: schedule it inline with a delay; the scoring queue is fast
      // enough that 60-90s usually suffices. A more robust approach is a dedicated
      // queue with a "wait for call to be scored" job.
      void scheduleFinalWebhook(this.init.apiKeyId, this.init.sessionId, this.init.externalId, callId);
    }

    // Notify client (if still connected) and close
    this.sendToClient({
      type: callId ? 'score.final' : 'error',
      ...(callId
        ? {
            call_id: callId,
            overall_score: 0, // placeholder - real score arrives via webhook once scoring completes
            pass: false,
            ts: new Date().toISOString(),
          }
        : { message: 'Session ended too short to score', code: 'TRANSCRIPT_TOO_SHORT' }),
    } as ServerFrame);

    if (!this.clientClosed) {
      try {
        this.init.client.close(1000, 'session ended');
      } catch {
        // ignore
      }
    }
  }

  private currentTranscript(): string {
    return [...this.finalSegments, ...this.rollingTranscript].join(' ').trim();
  }

  private totalTranscriptLength(): number {
    return this.finalSegments.reduce((acc, s) => acc + s.length + 1, 0);
  }

  private async getScorecardItems() {
    if (this.scorecardItemsCache) return this.scorecardItemsCache;
    if (!this.init.scorecardId) return null;
    this.scorecardItemsCache = await loadScorecardItems(this.init.scorecardId);
    return this.scorecardItemsCache;
  }

  private async getKBContext(): Promise<string> {
    if (this.kbContext !== null) return this.kbContext;
    this.kbContext = await getKBContext(this.init.organizationId);
    return this.kbContext;
  }

  private sendToClient(frame: ServerFrame): void {
    if (this.clientClosed) return;
    try {
      this.init.client.send(JSON.stringify(frame));
    } catch (err) {
      console.error(`[Stream ${this.init.sessionId}] Failed to send to client:`, (err as Error).message);
    }
  }
}

async function loadScorecardItems(scorecardId: string) {
  return query<{
    id: string;
    label: string;
    description: string | null;
    score_type: 'binary' | 'scale_1_5' | 'scale_1_10';
    severity: string | null;
  }>(
    `SELECT id, label, description, score_type, severity
       FROM scorecard_items
      WHERE scorecard_id = $1
      ORDER BY sort_order`,
    [scorecardId],
  );
}

/**
 * Polls until the streamed call has been scored, then fires the final webhook.
 * Best-effort: gives up after 5 minutes.
 */
async function scheduleFinalWebhook(
  apiKeyId: string,
  sessionId: string,
  externalId: string,
  callId: string,
): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000;
  const pollEvery = 5_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollEvery));
    const row = await queryOne<{
      status: string;
      overall_score: number | null;
      pass: boolean | null;
      duration_seconds: number | null;
      created_at: string;
    }>(
      `SELECT c.status, c.duration_seconds, c.created_at,
              cs.overall_score, cs.pass
         FROM calls c
         LEFT JOIN call_scores cs ON cs.call_id = c.id
        WHERE c.id = $1`,
      [callId],
    );

    if (!row) return;
    if (row.status === 'failed') return;
    if (row.status !== 'scored' || row.overall_score == null) continue;

    // Pull breaches that the standard scoring pipeline created
    const breaches = await query<{
      scorecard_item_id: string;
      scorecard_item_label: string;
      severity: string;
      evidence: string;
    }>(
      `SELECT b.scorecard_item_id, si.label as scorecard_item_label,
              b.severity, COALESCE(cis.evidence, '') as evidence
         FROM breaches b
         JOIN scorecard_items si ON si.id = b.scorecard_item_id
         LEFT JOIN call_item_scores cis ON cis.id = b.call_item_score_id
        WHERE b.call_id = $1`,
      [callId],
    );

    const startedAt = new Date(new Date(row.created_at).getTime() - (row.duration_seconds || 0) * 1000);

    await deliverWebhook(apiKeyId, sessionId, {
      event: 'session.scored',
      session_id: sessionId,
      external_id: externalId,
      call_id: callId,
      started_at: startedAt.toISOString(),
      ended_at: row.created_at,
      duration_seconds: row.duration_seconds || 0,
      overall_score: Number(row.overall_score),
      pass: Boolean(row.pass),
      breaches,
    });
    return;
  }
}

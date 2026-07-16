import { query } from '../db/client.js';
import { CLAUDE_PRICING, DEEPGRAM_PRICING } from '@callguard/shared';

// Prompt-cache pricing multipliers vs the base input rate. Reads bill ~0.1x
// regardless of TTL. Writes: 1.25x for the 5-minute TTL, 2x for the 1-hour
// TTL — the cache_control breakpoints in this codebase use ttl '1h'
// (see services/scoring.ts and transcript-cleanup.ts), so estimates use the
// 1-hour write rate. If a 5-minute breakpoint is ever reintroduced, this
// slightly overestimates its writes rather than underestimating.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 2.0;

export type UsageProvider = 'anthropic' | 'deepgram';
export type UsageOperation =
  | 'transcribe'
  | 'cleanup'
  | 'score'
  | 'verify'
  | 'live_score'
  | 'insights';

export interface RecordUsageInput {
  organizationId: string | null;
  callId?: string | null;
  provider: UsageProvider;
  operation: UsageOperation;
  modelId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  audioSeconds?: number;
  // Deepgram bills multichannel (split-stereo) per channel — ~2x the mono
  // rate. Callers that know the tenant's transcription_mode set this so mono
  // calls (the default & majority) aren't over-estimated at the stereo rate.
  deepgramMultichannel?: boolean;
}

/** Estimated USD cost for one usage event, from the shared pricing tables. */
export function estimateUsageCost(input: RecordUsageInput): number {
  if (input.provider === 'deepgram') {
    const rate = input.deepgramMultichannel
      ? DEEPGRAM_PRICING.per_minute
      : DEEPGRAM_PRICING.per_minute_mono;
    return ((input.audioSeconds ?? 0) / 60) * rate;
  }
  const pricing = input.modelId ? CLAUDE_PRICING[input.modelId] : undefined;
  if (!pricing) return 0;
  const inputCost = ((input.inputTokens ?? 0) / 1_000_000) * pricing.input_per_1m;
  const outputCost = ((input.outputTokens ?? 0) / 1_000_000) * pricing.output_per_1m;
  const cacheReadCost =
    ((input.cacheReadTokens ?? 0) / 1_000_000) * pricing.input_per_1m * CACHE_READ_MULTIPLIER;
  const cacheWriteCost =
    ((input.cacheCreationTokens ?? 0) / 1_000_000) * pricing.input_per_1m * CACHE_WRITE_MULTIPLIER;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Record one external-provider call in the usage ledger. Best-effort — usage
 * accounting must never break the pipeline, so failures are logged and swallowed.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    const cost = estimateUsageCost(input);
    await query(
      `INSERT INTO usage_events
         (organization_id, call_id, provider, operation, model_id,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          audio_seconds, est_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.organizationId,
        input.callId ?? null,
        input.provider,
        input.operation,
        input.modelId ?? null,
        Math.round(input.inputTokens ?? 0),
        Math.round(input.outputTokens ?? 0),
        Math.round(input.cacheReadTokens ?? 0),
        Math.round(input.cacheCreationTokens ?? 0),
        input.audioSeconds ?? null,
        cost,
      ]
    );
  } catch (err) {
    console.error('[Usage] Failed to record usage event:', (err as Error).message);
  }
}

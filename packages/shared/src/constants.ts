import type { Plan } from './types/coaching.js';

export const CALL_STATUSES = [
  'uploaded',
  'transcribing',
  'transcribed',
  'scoring',
  'scored',
  'skipped',
  'failed',
] as const;

// A call is skipped (not scored) if it's too short to evaluate meaningfully —
// either too few words OR (when known) too short a duration. Tunable.
export const MIN_SCOREABLE_WORDS = 30;
export const MIN_SCOREABLE_DURATION_SECONDS = 15;

export const SCORE_TYPES = ['binary', 'scale_1_5', 'scale_1_10'] as const;

export const USER_ROLES = ['superadmin', 'admin', 'supervisor', 'viewer', 'adviser'] as const;

export const PASS_THRESHOLD = 70;

export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

export const ALLOWED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
];

export const KB_MAX_FILE_SIZE_MB = 20;
export const KB_MAX_FILE_SIZE_BYTES = KB_MAX_FILE_SIZE_MB * 1024 * 1024;

export const KB_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
];

// Named model IDs — use these constants in code rather than hardcoded strings
// so that model changes and pricing lookups can never drift apart.
export const CLAUDE_MODELS = {
  HAIKU:   'claude-haiku-4-5-20251001',
  SONNET:  'claude-sonnet-4-6',
  OPUS:    'claude-opus-4-8',
} as const;

// Pricing constants used for cost estimates in superadmin billing/dashboard,
// keyed by the model_id stored on each call. Values are per 1M tokens, from the
// current Anthropic model catalog. Retired IDs are retained so historical
// call_scores rows still price correctly.
// Update these when model or provider pricing changes.
export const CLAUDE_PRICING: Record<string, { input_per_1m: number; output_per_1m: number }> = {
  // Current models
  'claude-haiku-4-5-20251001': { input_per_1m: 1.00,  output_per_1m: 5.00  },
  'claude-haiku-4-5':          { input_per_1m: 1.00,  output_per_1m: 5.00  },
  'claude-sonnet-4-6':         { input_per_1m: 3.00,  output_per_1m: 15.00 },
  'claude-opus-4-8':           { input_per_1m: 5.00,  output_per_1m: 25.00 },
  // Retired / legacy IDs — kept for historical billing rows
  'claude-sonnet-4-20250514':  { input_per_1m: 3.00,  output_per_1m: 15.00 },
  'claude-opus-4-20250514':    { input_per_1m: 15.00, output_per_1m: 75.00 },
};

// Provider pricing (Anthropic, Deepgram) is in USD; the business reports in GBP.
// Approximate FX rate used to convert provider costs for display. Override at
// runtime with the USD_TO_GBP env var; update this default periodically.
export const DEFAULT_USD_TO_GBP = 0.79;

// Deepgram nova-3 (per minute of audio). We transcribe with `multichannel: true`
// (split-stereo adviser/customer) AND `mip_opt_out: true` (excluded from the
// Model Improvement Program), which forgoes the MIP discount — so this is the
// full opted-out multichannel rate (~2x the discounted rate). Mono opted-out is
// ~0.0086/min.
export const DEEPGRAM_PRICING = { per_minute: 0.0104 };

// Monthly revenue per active seat by tier (GBP). A "seat" is an adviser with at
// least one scored call in the month. A tenant can override this with a
// negotiated rate (organizations.seat_price_override); when set, all that
// tenant's seats bill at the override regardless of tier.
export const SEAT_PRICING: Record<Plan, number> = {
  core: 199,
  professional: 299,
  enterprise: 399,
};

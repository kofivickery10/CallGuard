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
  HAIKU:      'claude-haiku-4-5-20251001',
  SONNET:     'claude-sonnet-4-20250514',
  SONNET_46:  'claude-sonnet-4-6',
  OPUS:       'claude-opus-4-8',
} as const;

// Pricing constants used for cost estimates in superadmin billing/dashboard.
// Update these when model or provider pricing changes.
export const CLAUDE_PRICING: Record<string, { input_per_1m: number; output_per_1m: number }> = {
  [CLAUDE_MODELS.HAIKU]:     { input_per_1m: 0.80,  output_per_1m: 4.00  },
  [CLAUDE_MODELS.SONNET]:    { input_per_1m: 3.00,  output_per_1m: 15.00 },
  [CLAUDE_MODELS.SONNET_46]: { input_per_1m: 3.00,  output_per_1m: 15.00 },
  [CLAUDE_MODELS.OPUS]:      { input_per_1m: 15.00, output_per_1m: 75.00 },
};

// Deepgram nova-3 standard tier (per minute of audio)
export const DEEPGRAM_PRICING = { per_minute: 0.0043 };

// Monthly revenue per active seat by tier (GBP). A "seat" is an adviser with at
// least one scored call in the month. A tenant can override this with a
// negotiated rate (organizations.seat_price_override); when set, all that
// tenant's seats bill at the override regardless of tier.
export const SEAT_PRICING: Record<Plan, number> = {
  core: 199,
  professional: 299,
  enterprise: 399,
};

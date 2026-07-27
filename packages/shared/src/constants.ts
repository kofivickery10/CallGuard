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

// Roles a tenant admin may assign to their own users. Excludes 'superadmin' —
// that role has no organization_id and grants cross-tenant platform access, so
// it must never be settable from a tenant-scoped endpoint.
export const TENANT_ASSIGNABLE_ROLES = ['admin', 'supervisor', 'viewer', 'adviser'] as const;

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

// Meeting/video recordings — the "off the phone" advice call. Teams, Zoom and
// Meet all export a single container with the mixed audio inside, so we accept
// the container, strip the video track on ingest (services/media.ts) and store
// only the audio. Nothing downstream (storage, retention, transcription,
// playback) ever sees a video file.
export const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime', // .mov
  'video/webm',
  'video/x-matroska', // .mkv
  'video/x-msvideo', // .avi
  'video/mpeg',
];

// Extension fallback for sources that stream a container as a generic binary
// type (the same problem fetchRemoteAudio's magic-byte sniffing solves for
// audio). Used only when the declared MIME type isn't recognisably video.
export const VIDEO_FILE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpg', '.mpeg'];

// A video container is many times the size of the audio we keep from it: a
// 45-60 minute Teams recording is routinely 300MB+ where the extracted MP3 is
// under 30MB. This ceiling therefore governs what may ARRIVE; MAX_FILE_SIZE_MB
// still describes the audio we store.
export const MAX_VIDEO_FILE_SIZE_MB = 500;
export const MAX_VIDEO_FILE_SIZE_BYTES = MAX_VIDEO_FILE_SIZE_MB * 1024 * 1024;

// What an upload endpoint accepts before we know whether we're holding audio or
// a video container. The type is still restricted by ALLOWED_UPLOAD_MIME_TYPES;
// only the size ceiling is the permissive one.
export const ALLOWED_UPLOAD_MIME_TYPES = [...ALLOWED_MIME_TYPES, ...VIDEO_MIME_TYPES];
export const MAX_UPLOAD_FILE_SIZE_BYTES = MAX_VIDEO_FILE_SIZE_BYTES;

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
  // Current-generation Sonnet, used for scorecard scoring. Kept separate from
  // SONNET rather than replacing it: the live scorer (services/live-scorer.ts)
  // runs on a latency-critical real-time path, and Sonnet 5 enables adaptive
  // thinking by default, which is the wrong trade there. Move those callers
  // deliberately, not by editing one constant.
  SONNET_5: 'claude-sonnet-5',
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
  // List rate. Sonnet 5 is on introductory pricing ($2/$10) until 2026-08-31,
  // so cost estimates read high until then — deliberately the safe direction
  // for a billing estimate, and correct from 1 September without a code change.
  'claude-sonnet-5':           { input_per_1m: 3.00,  output_per_1m: 15.00 },
  'claude-opus-4-8':           { input_per_1m: 5.00,  output_per_1m: 25.00 },
  // Retired / legacy IDs — kept for historical billing rows
  'claude-sonnet-4-20250514':  { input_per_1m: 3.00,  output_per_1m: 15.00 },
  'claude-opus-4-20250514':    { input_per_1m: 15.00, output_per_1m: 75.00 },
};

// Provider pricing (Anthropic, Deepgram) is in USD; the business reports in GBP.
// Approximate FX rate used to convert provider costs for display. Override at
// runtime with the USD_TO_GBP env var; update this default periodically.
export const DEFAULT_USD_TO_GBP = 0.79;

// Deepgram nova-3 (per minute of audio), opted out of the Model Improvement
// Program (`mip_opt_out: true`, which forgoes the MIP discount — a DPA/FCA
// requirement, see services/transcription.ts). Deepgram bills multichannel
// (split-stereo) per channel, so it's ~2x mono; which rate applies is the
// tenant's transcription_mode. `per_minute` (multichannel) is also the
// conservative blended rate used for platform-level MTD estimates in
// routes/superadmin.ts that can't see per-call mode.
export const DEEPGRAM_PRICING = {
  per_minute: 0.0104, // multichannel (stereo_multichannel tenants)
  per_minute_mono: 0.0086, // mono_diarize tenants — the default & majority
};

// Monthly revenue per billable seat by tier (GBP). A "seat" is any tenant user
// who isn't billing_exempt (headcount billing — every provisioned user, not
// just those active on calls). A tenant can override this with a negotiated
// rate (organizations.seat_price_override); when set, all that tenant's seats
// bill at the override regardless of tier.
export const SEAT_PRICING: Record<Plan, number> = {
  core: 199,
  professional: 299,
  enterprise: 399,
};

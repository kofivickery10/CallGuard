export type LiveSessionStatus = 'opening' | 'active' | 'ended' | 'failed';
export type LiveSessionSource = 'sdk' | 'twilio' | 'aws_connect' | 'generic_dialer';

export interface LiveSession {
  id: string;
  organization_id: string;
  api_key_id: string;
  source: LiveSessionSource;
  external_id: string | null;
  agent_id: string | null;
  scorecard_id: string | null;
  status: LiveSessionStatus;
  metadata: Record<string, unknown>;
  consent_required: boolean;
  consent_captured_at: string | null;
  consent_excerpt: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript_text: string | null;
  final_call_id: string | null;
  error_message: string | null;
  audio_format: string | null;
  audio_sample_rate: number | null;
  created_at: string;
}

// ─── Client → backend frames (over WebSocket) ────────────────────────────

export interface ClientSessionStartFrame {
  type: 'session.start';
  external_id?: string;
  agent_id?: string;
  scorecard_id?: string;
  audio_format?: 'opus' | 'linear16' | 'mulaw';
  audio_sample_rate?: number;
  metadata?: Record<string, unknown>;
}

export interface ClientConsentCapturedFrame {
  type: 'consent.captured';
  ts: string;
  transcript_excerpt?: string;
}

export interface ClientPingFrame {
  type: 'ping';
}

export interface ClientSessionEndFrame {
  type: 'session.end';
  ts: string;
}

export type ClientControlFrame =
  | ClientSessionStartFrame
  | ClientConsentCapturedFrame
  | ClientPingFrame
  | ClientSessionEndFrame;

// ─── Backend → client frames ─────────────────────────────────────────────

export interface ServerAckFrame {
  type: 'ack';
  session_id: string;
}

export interface ServerTranscriptPartialFrame {
  type: 'transcript.partial';
  text: string;
  speaker: number | null;
  is_final: boolean;
  ts: string;
}

export interface ServerBreachDetectedFrame {
  type: 'breach.detected';
  scorecard_item_id: string;
  scorecard_item_label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  evidence: string;
  ts: string;
}

export interface ServerScoreFinalFrame {
  type: 'score.final';
  call_id: string;
  overall_score: number;
  pass: boolean;
  ts: string;
}

export interface ServerErrorFrame {
  type: 'error';
  message: string;
  code?: string;
}

export interface ServerPongFrame {
  type: 'pong';
}

export type ServerFrame =
  | ServerAckFrame
  | ServerTranscriptPartialFrame
  | ServerBreachDetectedFrame
  | ServerScoreFinalFrame
  | ServerErrorFrame
  | ServerPongFrame;

// ─── Outbound webhook payloads ───────────────────────────────────────────

export interface WebhookBreachPayload {
  event: 'session.breach_detected';
  session_id: string;
  external_id: string | null;
  ts: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  scorecard_item_id: string;
  scorecard_item_label: string;
  evidence: string;
}

export interface WebhookScoredPayload {
  event: 'session.scored';
  session_id: string;
  external_id: string | null;
  call_id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  overall_score: number;
  pass: boolean;
  breaches: Array<{
    scorecard_item_id: string;
    scorecard_item_label: string;
    severity: string;
    evidence: string;
  }>;
}

// Fired when a batch-ingested or uploaded call finishes scoring (not a live session).
export interface WebhookCallScoredPayload {
  event: 'call.scored';
  call_id: string;
  external_id: string | null;
  agent_name: string | null;
  scorecard_id: string;
  overall_score: number;
  pass: boolean;
  scored_at: string;
  // Customer fields — present when the call is linked to a customer record.
  customer_id: string | null;
  customer_phone: string | null;
  customer_external_crm_id: string | null;
  breaches: Array<{
    scorecard_item_id: string;
    scorecard_item_label: string;
    severity: string;
    evidence: string;
  }>;
}

// Fired when a customer journey finishes scoring (spec §9 — multi-call, not
// a single upload/session). Mirrors WebhookCallScoredPayload's shape so
// partner integrations (and services/zoho.ts) can handle both with the same
// code, keyed on `event` / the presence of `journey_id` vs `call_id`.
export interface WebhookJourneyScoredPayload {
  event: 'journey.scored';
  journey_id: string;
  scorecard_id: string;
  branch: string | null;
  overall_score: number;
  pass: boolean;
  scored_at: string;
  // The wrap-up/closing call's agent — the most relevant attribution point
  // for commission/QA purposes when a journey spans several advisers.
  agent_name: string | null;
  customer_id: string;
  customer_phone: string | null;
  customer_external_crm_id: string | null;
  breaches: Array<{
    scorecard_item_id: string;
    scorecard_item_label: string;
    severity: string;
    evidence: string;
  }>;
}

export type WebhookPayload =
  | WebhookBreachPayload
  | WebhookScoredPayload
  | WebhookCallScoredPayload
  | WebhookJourneyScoredPayload;

// ─── Token mint ──────────────────────────────────────────────────────────

export interface MintTokenRequest {
  external_id?: string;
  agent_id?: string;
  scorecard_id?: string;
  metadata?: Record<string, unknown>;
}

export interface MintTokenResponse {
  session_id: string;
  token: string;
  ws_url: string;
  expires_at: string;
}

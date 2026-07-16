import type { ItemResult } from './scorecard.js';

export type CallStatus =
  // Metadata-only capture for sales_only tenants: the CloudTalk webhook has
  // recorded the call's metadata but no audio has been fetched or transcribed
  // yet — that happens later, driven by a Zoho sale trigger (see
  // services/journey.ts). Has no file_key/transcript until then.
  | 'captured'
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'scoring'
  | 'scored'
  | 'skipped'
  | 'failed';

export interface Call {
  id: string;
  organization_id: string;
  uploaded_by: string | null;
  file_name: string;
  // null for 'captured' calls — audio isn't fetched until a sale trigger
  // hydrates them (see services/journey.ts / jobs/processors/hydrate-call.ts).
  file_key: string | null;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  mime_type: string | null;
  status: CallStatus;
  error_message: string | null;
  transcript_text: string | null;
  agent_id: string | null;
  agent_name: string | null;
  customer_phone: string | null;
  call_date: string | null;
  tags: string[];
  external_id: string | null;
  ingestion_source: 'upload' | 'api' | 'sftp' | 'live_stream' | 'dialer_webhook';
  scorecard_id: string | null;
  dialer_connection_id: string | null;
  journey_id: string | null;
  is_exemplar: boolean;
  exemplar_reason: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallScore {
  id: string;
  call_id: string;
  scorecard_id: string;
  scorecard_version: number;
  overall_score: number | null;
  pass: boolean | null;
  scored_at: string | null;
  model_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  prior_coaching_count: number;
  created_at: string;
}

export interface CallItemScore {
  id: string;
  call_score_id: string;
  scorecard_item_id: string;
  // null for na / manual_review checkpoints — they are never AI-scored.
  score: number | null;
  normalized_score: number | null;
  confidence: number | null;
  evidence: string | null;
  reasoning: string | null;
  result: ItemResult;
  source_timestamp: number | null;
  created_at: string;
}

export interface CallWithScores extends Call {
  scores?: (CallScore & {
    item_scores?: CallItemScore[];
  })[];
}

export type CallStatus =
  | 'uploaded'
  | 'transcribing'
  | 'transcribed'
  | 'scoring'
  | 'scored'
  | 'failed';

export interface Call {
  id: string;
  organization_id: string;
  uploaded_by: string | null;
  file_name: string;
  file_key: string;
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
  ingestion_source: 'upload' | 'api' | 'sftp';
  is_exemplar: boolean;
  exemplar_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallScore {
  id: string;
  call_id: string;
  scorecard_id: string;
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
  score: number;
  normalized_score: number;
  confidence: number | null;
  evidence: string | null;
  reasoning: string | null;
  created_at: string;
}

export interface CallWithScores extends Call {
  scores?: (CallScore & {
    item_scores?: CallItemScore[];
  })[];
}

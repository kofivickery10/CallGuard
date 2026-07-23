// Data Capture module (generic, cross-tenant): per-tenant capture forms — a
// named set of typed questions/fields the AI extracts from every scored
// call/journey, separate from scorecards/QA. Industry framing (an "insurer
// question set", a "supplier order form") is tenant configuration, never code.

export type CaptureAnswerType = 'text' | 'yes_no' | 'number' | 'currency' | 'date' | 'choice';

// Drives capture vs confirm-only. Answers classed personal/health are NEVER
// stored as literal values — asked/answered is recorded, the value suppressed.
// The transcript the model reads is already redacted upstream (Deepgram
// source-side redaction); this classification is enforcement in depth, applied
// in code by services/capture.ts regardless of what the model returns.
export type CapturePiiClass = 'none' | 'personal' | 'health';

export type CaptureAnswerResult =
  | 'captured'        // asked, answered, value stored
  | 'confirmed_only'  // asked, answered, value suppressed (pii_class != none)
  | 'missed'          // never asked, or asked but no answer given
  | 'na'              // field's applies_when branch didn't apply
  | 'manual_review';  // low confidence on a required field — human decides

export type CaptureRunStatus = 'pending' | 'needs_form' | 'running' | 'completed' | 'failed';

export type CaptureRuleSource = 'crm_field' | 'source_document' | 'manual';

export interface CaptureFormField {
  id: string;
  form_id: string;
  sort_order: number;
  // The question as the agent is expected to ask it / the field name.
  label: string;
  // Guidance for the AI: what counts as this question being asked, common
  // phrasings, what a valid answer looks like.
  description: string | null;
  answer_type: CaptureAnswerType;
  // For answer_type='choice': the allowed values.
  choices: string[] | null;
  required: boolean;
  pii_class: CapturePiiClass;
  // Optional branch gate, same semantics as scorecard items' applies_when.
  applies_when: string | null;
  archived_at?: string | null;
  created_at: string;
}

export interface CaptureForm {
  id: string;
  organization_id: string;
  name: string;
  // What this form is FOR, in the tenant's own terms (an insurer, a supplier,
  // a product line). Matched by resolution rules and shown in the UI.
  context_label: string | null;
  version: number;
  is_active: boolean;
  archived_at?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  fields?: CaptureFormField[];
}

// Which form applies to a call/journey; evaluated in priority order, first
// match wins. 'manual' = no auto-resolution, a human picks in the UI.
export interface CaptureFormRule {
  id: string;
  organization_id: string;
  form_id: string;
  source: CaptureRuleSource;
  // For crm_field: the sale-trigger payload key to read (e.g. "Insurer").
  source_key: string | null;
  // Selects this form on a case-insensitive substring match.
  match_value: string | null;
  priority: number;
  is_active: boolean;
  created_at: string;
}

export interface CaptureRun {
  id: string;
  organization_id: string;
  journey_id: string | null;
  call_id: string | null;
  // Null only on needs_form runs — "no form could be resolved" carries no
  // form (migration 061); every other status pins the form + version.
  form_id: string | null;
  form_version: number | null;
  status: CaptureRunStatus;
  model_id: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CaptureAnswer {
  id: string;
  run_id: string;
  field_id: string;
  asked: boolean;
  answered: boolean;
  // Literal answer — only ever populated for pii_class='none' fields.
  captured_value: string | null;
  value_redacted: boolean;
  result: CaptureAnswerResult;
  confidence: number | null;
  // Verbatim transcript quote supporting the answer.
  evidence: string | null;
  source_call_id: string | null;
  reasoning: string | null;
  created_at: string;
}

// Input shapes for the admin CRUD routes.
export interface CaptureFormFieldInput {
  label: string;
  description?: string | null;
  answer_type?: CaptureAnswerType;
  choices?: string[] | null;
  required?: boolean;
  pii_class?: CapturePiiClass;
  applies_when?: string | null;
  sort_order?: number;
}

export interface CaptureFormInput {
  name: string;
  context_label?: string | null;
  fields: CaptureFormFieldInput[];
}

// Confidence below which a required field's answer routes to manual_review
// instead of being trusted — mirrors the consent-gate philosophy in scoring:
// a false "captured" is worse than a human taking a look.
export const CAPTURE_REVIEW_CONFIDENCE_THRESHOLD = 0.6;

import { config } from '../config.js';
import { CLAUDE_MODELS, CAPTURE_REVIEW_CONFIDENCE_THRESHOLD } from '@callguard/shared';
import type { CaptureFormField, CaptureAnswerResult } from '@callguard/shared';
import { CACHE_1H, CACHE_TTL_HEADERS } from './scoring.js';
import { CALL_MARKER } from './journey-transcript.js';

// ============================================================
// Data Capture (generic, cross-tenant): extract a capture form's typed
// answers from a call/journey transcript. Separate from scoring/QA — a
// capture failure never blocks or taints a score, and capture results live
// in their own tables (migrations 059/060).
//
// PII stance: the transcript the model reads is already redacted upstream
// (Deepgram source-side redaction to typed tags), AND fields classed
// personal/health are confirm-only — sanitizeAnswers() suppresses any value
// the model returns for them, in code, regardless of the prompt. Two layers,
// neither trusted alone.
// ============================================================

const DEFAULT_CAPTURE_MODEL = CLAUDE_MODELS.HAIKU;

// Deepgram redaction tags, e.g. [PII_NAME_1], [PHONE_NUMBER_2], [PHI_..._1].
// If a "captured value" is just a redaction tag, there is no value to store.
const REDACTION_TAG_RE = /^\[[A-Z][A-Z0-9_]*_\d+\]$/;

export interface RawCaptureAnswer {
  field_id: string;
  asked: boolean;
  answered: boolean;
  value: string | null;
  confidence: number;
  evidence: string;
  reasoning: string;
}

export interface SanitizedCaptureAnswer {
  field_id: string;
  asked: boolean;
  answered: boolean;
  captured_value: string | null;
  value_redacted: boolean;
  result: CaptureAnswerResult;
  confidence: number;
  evidence: string | null;
  // 1-based journey call index parsed from the evidence's [Call N] marker;
  // null when unattributable (single-call capture, or no marker given).
  source_call_index: number | null;
  reasoning: string | null;
}

function buildCapturePrompt(
  transcript: string,
  fields: CaptureFormField[],
  industry: string | null,
  journeyMode: boolean
): { cached: string; dynamic: string } {
  const fieldsBlock = fields
    .map((f, i) => {
      const typeDesc = {
        text: 'Free text — capture the answer as stated.',
        yes_no: 'Yes/no — the value must be exactly "yes" or "no".',
        number: 'Number — the value must be a plain number (digits, optional decimal point).',
        currency: 'Currency amount — the value must be a plain number without symbols (e.g. 150000).',
        date: 'Date — the value must be in DD/MM/YYYY format where determinable.',
        choice: `One of: ${(f.choices ?? []).map((c) => `"${c}"`).join(', ')}.`,
      }[f.answer_type];
      const confirmOnly = f.pii_class !== 'none'
        ? '\n  CONFIRM-ONLY: this answer is personal data. Report whether it was asked and answered, quote the evidence (redaction tags included), but return value: null — never attempt to reconstruct or guess the actual value.'
        : '';
      return `Field ${i + 1} (ID: ${f.id}):
  Question: ${f.label}${f.description ? `\n  Guidance: ${f.description}` : ''}
  Answer type: ${typeDesc}${f.required ? '' : '\n  Optional: the agent is not required to ask this on every call.'}${confirmOnly}`;
    })
    .join('\n\n');

  const domain = industry?.trim();
  const callHeadline = domain ? `a UK ${domain} call` : 'a UK sales or customer-service call';

  const cached = `You are a data-capture analyst reviewing ${callHeadline}. The agent is required to ask the customer a defined set of questions. Your job: for each field below, determine whether the question was asked, whether the customer answered, and what the answer was.

## Important Context

- Speaker labels ("Agent" / "Customer") are auto-generated and may occasionally be swapped — use content to judge who is who.
- Audio quality may be low; consider near-homophones when matching questions to their phrasings. A question counts as asked if its substance was covered, even with different wording.
- Personal/sensitive data is redacted to typed tags like [PII_NAME_1], [PHONE_NUMBER_1] or [PHI_...]. A tag is positive evidence the customer DID give that information — treat the question as answered and quote the tag as evidence. Never invent, reconstruct or guess a redacted value.
- Distinguish carefully between "asked but not answered" (asked=true, answered=false) and "never asked" (asked=false, answered=false). An answer volunteered by the customer without the agent asking still counts as answered (asked=false, answered=true) — note that in the reasoning.

## Fields to Capture

${fieldsBlock}

## Instructions

For every field above, return:
1. asked — did the agent ask (or substantively cover) this question?
2. answered — did the customer give an answer?
3. value — the customer's answer, normalised to the field's answer type; null if unanswered or the field is marked CONFIRM-ONLY
4. confidence — 0.0 to 1.0
5. evidence — a direct quote from the transcript (or "No relevant evidence found")
6. reasoning — 1 short sentence
${journeyMode ? `
This is a customer JOURNEY spanning multiple calls, each delimited by a header like "=== Call 2 (15/01/2026, agent: Jane) ===". A question asked or answered in ANY call counts. Prefix each evidence quote with the matching call marker in brackets exactly as shown, e.g. \`[Call 2] "...quote..."\`. If the customer gave different answers in different calls, capture the most recent and note the change in the reasoning.
` : ''}
Only report what is explicitly present in the transcript${journeyMode ? 's' : ''}. If unclear, say so via low confidence — never guess a value.`;

  const dynamic = `

## Call Transcript${journeyMode ? "s (this customer's journey)" : ''}

<transcript>
${transcript}
</transcript>`;

  return { cached, dynamic };
}

/**
 * One extraction pass: transcript + form fields -> raw per-field answers.
 * Mirrors scoreTranscript's shape (streamed, forced tool call, cacheable
 * prefix) so ops characteristics and cost behaviour match scoring.
 */
export async function captureFromTranscript(
  transcript: string,
  fields: CaptureFormField[],
  industry: string | null = null,
  journeyMode: boolean = false,
  modelOverride: string | null = null
): Promise<{
  answers: RawCaptureAnswer[];
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  model: string;
}> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for capture');
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const model = modelOverride ?? DEFAULT_CAPTURE_MODEL;
  const prompt = buildCapturePrompt(transcript, fields, industry, journeyMode);

  // Same truncation-avoidance logic as scoring: budget per field, capped.
  const perFieldBudget = 300;
  const maxTokens = Math.min(32000, 2048 + fields.length * perFieldBudget);

  const response = await client.messages.stream({
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          // Stable prefix (form + instructions) — identical for every capture
          // against the same form version, so it caches across a tenant's runs.
          { type: 'text', text: prompt.cached, cache_control: CACHE_1H },
          { type: 'text', text: prompt.dynamic },
        ],
      },
    ],
    tools: [
      {
        name: 'submit_answers',
        description: 'Submit the captured answers for all fields',
        input_schema: {
          type: 'object' as const,
          properties: {
            answers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field_id: { type: 'string' },
                  asked: { type: 'boolean' },
                  answered: { type: 'boolean' },
                  value: { type: ['string', 'null'] },
                  confidence: { type: 'number', minimum: 0, maximum: 1 },
                  evidence: { type: 'string' },
                  reasoning: { type: 'string' },
                },
                required: ['field_id', 'asked', 'answered', 'value', 'confidence', 'evidence', 'reasoning'],
              },
            },
          },
          required: ['answers'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'submit_answers' },
  }, CACHE_TTL_HEADERS).finalMessage();

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return structured capture answers');
  }
  const output = toolUse.input as { answers?: RawCaptureAnswer[] };
  if (!output || !Array.isArray(output.answers)) {
    throw new Error(
      `Claude returned incomplete capture answers (stop_reason=${response.stop_reason}, fields=${fields.length}, max_tokens=${maxTokens}) — likely truncated`
    );
  }

  return {
    answers: output.answers,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
    model,
  };
}

/**
 * Normalise a model-returned value against the field's answer type. Tolerant:
 * a value that can't be normalised is kept verbatim (the field is TEXT) —
 * a human reading the report still sees what was said.
 */
function coerceValue(field: CaptureFormField, value: string): string {
  const v = value.trim();
  switch (field.answer_type) {
    case 'yes_no': {
      const lower = v.toLowerCase();
      if (/^(yes|yeah|yep|correct|true|y)\b/.test(lower)) return 'yes';
      if (/^(no|nope|false|n)\b/.test(lower)) return 'no';
      return v;
    }
    case 'number':
    case 'currency': {
      const numeric = v.replace(/[£$,\s]/g, '');
      return /^-?\d+(\.\d+)?$/.test(numeric) ? numeric : v;
    }
    case 'choice': {
      const match = (field.choices ?? []).find((c) => c.toLowerCase() === v.toLowerCase());
      return match ?? v;
    }
    default:
      return v;
  }
}

/**
 * The enforcement layer between the model's raw output and the database.
 * Never trust the model with the PII rules: confirm-only fields have any
 * returned value suppressed here, values that are just redaction tags are
 * treated as redacted, and low-confidence required answers route to
 * manual_review rather than being recorded as fact.
 */
export function sanitizeAnswers(
  fields: CaptureFormField[],
  raw: RawCaptureAnswer[]
): SanitizedCaptureAnswer[] {
  const byId = new Map(raw.map((a) => [a.field_id, a]));

  return fields.map((field) => {
    const a = byId.get(field.id);

    // Field the model never reported on: treat as missed at zero confidence —
    // visible in the report and flagged, never silently absent.
    if (!a) {
      return {
        field_id: field.id,
        asked: false,
        answered: false,
        captured_value: null,
        value_redacted: false,
        result: 'missed' as const,
        confidence: 0,
        evidence: null,
        source_call_index: null,
        reasoning: 'Not reported by the extraction pass',
      };
    }

    const confidence = Math.max(0, Math.min(1, Number(a.confidence) || 0));

    // Parse the [Call N] evidence marker for source-call attribution.
    let evidence: string | null = typeof a.evidence === 'string' ? a.evidence.trim() : null;
    let sourceCallIndex: number | null = null;
    if (evidence) {
      const m = evidence.match(CALL_MARKER);
      if (m) {
        sourceCallIndex = parseInt(m[1], 10);
        evidence = evidence.replace(CALL_MARKER, '').trim();
      }
      if (!evidence || /^no relevant evidence/i.test(evidence)) evidence = null;
    }

    const asked = a.asked === true;
    const answered = a.answered === true;

    let capturedValue: string | null = null;
    let valueRedacted = false;
    let result: CaptureAnswerResult;

    if (!answered) {
      result = 'missed';
    } else if (field.pii_class !== 'none') {
      // Confirm-only: suppress whatever the model returned, unconditionally.
      result = 'confirmed_only';
      valueRedacted = true;
    } else {
      const rawValue = typeof a.value === 'string' ? a.value.trim() : '';
      if (!rawValue || REDACTION_TAG_RE.test(rawValue)) {
        // Answered but the value is unavailable (redacted upstream) — the
        // fact of the answer is still confirmed.
        result = 'confirmed_only';
        valueRedacted = REDACTION_TAG_RE.test(rawValue);
      } else {
        capturedValue = coerceValue(field, rawValue);
        result = 'captured';
      }
    }

    // A required ANSWER the AI isn't sure about goes to a human, not into the
    // record as fact — same philosophy as consent gates in scoring. This must
    // never apply to a missed field: reclassifying a low-confidence miss to
    // manual_review would silently remove it from the missed-required count,
    // the capture_missed_required alert, and the coverage report — hiding
    // exactly the uncertain gaps most worth flagging. A miss stays a miss;
    // low confidence there just means the evidence is weaker.
    if (field.required && answered && confidence < CAPTURE_REVIEW_CONFIDENCE_THRESHOLD) {
      result = 'manual_review';
    }

    return {
      field_id: field.id,
      asked,
      answered,
      captured_value: result === 'captured' ? capturedValue : null,
      value_redacted: valueRedacted,
      result,
      confidence,
      evidence,
      source_call_index: sourceCallIndex,
      reasoning: typeof a.reasoning === 'string' && a.reasoning.trim() ? a.reasoning.trim() : null,
    };
  });
}

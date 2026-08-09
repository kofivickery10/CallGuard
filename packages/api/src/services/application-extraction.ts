import { config } from '../config.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { CACHE_TTL_HEADERS } from './scoring.js';
import { normaliseForDetection, type ParsedPair } from './application-pdf.js';

// ============================================================
// Model extraction of an application document — the fallback of last resort.
//
// The deterministic path is always preferred: a stored profile parses a
// document for free, reproducibly, and a flag raised from it can be re-derived
// on demand. But that path has a hole with a sale-shaped outline in it. An
// insurer nobody has configured — the firm "starts selling another insurer
// without our knowledge" — produces a document no strategy fits, and until a
// format exists and is corroborated, every sale on it sits unchecked. For the
// first sale of ANY new format that wait is structural: corroboration needs a
// second sale by definition.
//
// So when, and only when, the deterministic path cannot read this sale's
// document TODAY, a model reads it directly: every question the document asks
// and the answer recorded against it. The result is marked on the run as
// extraction_method = 'model' and is treated as provisional — the moment a
// profile for the format goes live, activateProfile re-queues these runs and
// the deterministic parse replaces the model's reading (see migration 093).
//
// WHAT MAKES THIS SAFE ENOUGH TO USE
//
// A model's reading cannot be re-derived, so it is not trusted — it is checked.
// Every question and every answer the model returns must actually appear in the
// document text, tested with the same normalisation profile matching uses. A
// pair the document does not contain is dropped, and if too many drop the whole
// extraction is refused, because a model paraphrasing a document it half-read is
// worse than a sale honestly marked unread. An invented application answer
// would otherwise become a false mismatch — an allegation against an adviser
// fabricated by the fallback that was meant to protect them.
// ============================================================

const DEFAULT_EXTRACTION_MODEL = CLAUDE_MODELS.HAIKU;

/**
 * Hard cap on how much document the model sees. An application pack's text runs
 * to a few tens of thousands of characters; anything approaching this cap is not
 * an application, and an unbounded read of a malformed PDF must not be able to
 * spend an arbitrary amount per sale.
 */
const MAX_DOCUMENT_CHARS = 150_000;

/**
 * The one output-size failure that must be loud: a truncated tool call drops the
 * tail of the question set, and a missing question reads downstream as "the
 * adviser never asked it". High enough for the largest question set observed
 * (95 questions on one portal export) with room to spare.
 */
const MAX_OUTPUT_TOKENS = 20_000;

/** Strings that belong to the OTHER documents in a pack, never to the application. */
const LEAK = /commission|underwriting decision/i;

export interface ExtractionRejection {
  /** Why the document (or the model's reading of it) was refused. */
  reason:
    | 'not_application'
    | 'nothing_extracted'
    | 'too_many_unverified'
    | 'truncated';
  detail: string;
}

export class ApplicationExtractionError extends Error {
  rejection: ExtractionRejection;
  /**
   * A refused reading still cost a model pass. Carried on the error so the
   * caller can bill it — every other path records usage, and a rejection being
   * free would make the failure mode invisible on the tenant's spend.
   */
  usage: { input_tokens: number; output_tokens: number } | null;
  model: string | null;
  constructor(
    rejection: ExtractionRejection,
    meta?: { usage: { input_tokens: number; output_tokens: number }; model: string }
  ) {
    super(`${rejection.reason}: ${rejection.detail}`);
    this.rejection = rejection;
    this.usage = meta?.usage ?? null;
    this.model = meta?.model ?? null;
  }
}

const EXTRACTION_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    is_application: {
      type: 'boolean',
      description:
        'True only if this document records insurance application questions with answers given by or for a customer. False for a suitability report, quotation, illustration, sanctions search, covering letter, policy terms or anything else.',
    },
    insurer: {
      type: ['string', 'null'],
      description: 'The insurer named in the document, if one is named. Null otherwise — never guess.',
    },
    pairs: {
      type: 'array',
      description: 'Every question the document asks, in document order.',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The question EXACTLY as the document words it, character for character. Never paraphrase, summarise or complete a question.',
          },
          section: {
            type: ['string', 'null'],
            description: 'The section heading this question sits under, exactly as printed, if there is one.',
          },
          guidance: {
            type: ['string', 'null'],
            description: 'Clarifying text the document prints under the question, verbatim, if any.',
          },
          choices: {
            type: 'array',
            items: { type: 'string' },
            description: 'The multiple-choice options offered, verbatim, if any.',
          },
          answer: {
            type: ['string', 'null'],
            description:
              'The recorded answer EXACTLY as the document states it. Null when the document records no answer — never infer one.',
          },
        },
        required: ['question', 'section', 'guidance', 'choices', 'answer'],
      },
    },
  },
  required: ['is_application', 'insurer', 'pairs'],
};

const INSTRUCTIONS = `You are reading the text of a document attached to an insurance sale,
extracted from a PDF. Your job is to report every question the document asks and
the answer recorded against each — nothing else.

Rules, all of which are enforced in code after you answer:

1. VERBATIM ONLY. Every question and every answer must be copied character for
   character from the document. Each one is checked against the document text and
   discarded if it is not found there, so paraphrasing loses the question
   entirely. Line breaks inside a sentence may be joined with a single space.

2. NEVER INVENT AN ANSWER. A question the document leaves unanswered gets
   answer: null. An answer you report is later compared against what the
   customer said on a recorded call, and a wrong one here becomes a false
   accusation against an adviser.

3. ONLY THE APPLICATION. If the document is not an application question-and-
   answer record — a suitability report, a quotation, an illustration, a
   sanctions search, a covering letter, policy terms — set is_application to
   false and return no pairs. If the application sits inside a larger pack,
   extract only the application: never anything from a quote, an underwriting
   decision, or the firm's commission arrangements.

4. EVERY QUESTION. Include repeated question wordings each time they occur —
   forms genuinely ask "have you had any of these?" several times under
   different sections, and the section field is what tells them apart. Include
   questions in a "no longer included in your application" or similar withdrawn
   section too; their answers are part of the record.

5. Keep document order.`;

/** The model's reading of one question, before verification. */
interface RawExtractedPair {
  question?: unknown;
  section?: unknown;
  guidance?: unknown;
  choices?: unknown;
  answer?: unknown;
}

export interface VerifiedExtraction {
  pairs: ParsedPair[];
  /** Pairs the document text could not confirm, discarded. */
  dropped: number;
  /** How many pairs the model returned before verification. */
  returned: number;
}

/**
 * Keep only the pairs the document itself can vouch for.
 *
 * The test is the same normalised-substring check profile matching uses, so
 * "appears in the document" means exactly what it means everywhere else: case,
 * whitespace and typographic punctuation are forgiven, wording is not. Questions
 * AND answers are both checked — a fabricated answer is the more dangerous of
 * the two, because it flows into a comparison against the call.
 */
export function verifyExtractedPairs(rawText: string, raw: unknown[]): VerifiedExtraction {
  const haystack = normaliseForDetection(rawText);
  const pairs: ParsedPair[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      dropped++;
      continue;
    }
    const e = entry as RawExtractedPair;
    const question = typeof e.question === 'string' ? e.question.replace(/\s+/g, ' ').trim() : '';
    if (question === '' || !haystack.includes(normaliseForDetection(question))) {
      dropped++;
      continue;
    }

    let answer =
      typeof e.answer === 'string' && e.answer.trim() !== ''
        ? e.answer.replace(/\s+/g, ' ').trim()
        : null;
    if (answer !== null && !haystack.includes(normaliseForDetection(answer))) {
      // The question is real but the answer is not in the document. Dropping the
      // whole pair, not nulling the answer: null downstream means "the insurer
      // recorded no answer", and asserting that on the model's say-so would read
      // as the adviser having skipped the question.
      dropped++;
      continue;
    }

    // Nothing from the rest of the pack may ride in on a verified pair.
    if (LEAK.test(question) || (answer !== null && LEAK.test(answer))) {
      dropped++;
      continue;
    }

    const section = typeof e.section === 'string' && e.section.trim() !== '' ? e.section.trim() : null;
    const modelGuidance =
      typeof e.guidance === 'string' && e.guidance.trim() !== '' ? e.guidance.trim() : null;
    // The section heading is folded into guidance rather than given its own
    // field: guidance already feeds both the reviewer's screen and the search
    // terms, and the heading is what distinguishes the third "have you had any
    // of these?" from the first.
    const guidance =
      [section ? `Section: ${section}` : null, modelGuidance].filter(Boolean).join(' — ') || null;

    pairs.push({
      order: pairs.length + 1,
      question,
      guidance,
      choices: Array.isArray(e.choices)
        ? e.choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        : [],
      answer,
    });
  }

  return { pairs, dropped, returned: raw.length };
}

/**
 * Read an application document with a model, verified against the document.
 *
 * Throws ApplicationExtractionError when the document is not an application or
 * the reading cannot be trusted; callers treat that as "this candidate is not
 * it" and move on. Ordinary errors (network, API) propagate as themselves.
 */
export async function extractApplicationPairs(
  rawText: string,
  modelOverride: string | null = null
): Promise<{
  pairs: ParsedPair[];
  insurer: string | null;
  dropped: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for document extraction');
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = modelOverride ?? DEFAULT_EXTRACTION_MODEL;
  const text = rawText.slice(0, MAX_DOCUMENT_CHARS);

  const response = await client.messages.stream(
    {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: INSTRUCTIONS },
            { type: 'text', text: `Document text:\n\n${text}` },
          ],
        },
      ],
      tools: [
        {
          name: 'submit_extraction',
          description: 'Report every question and recorded answer in this document',
          input_schema: EXTRACTION_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_extraction' },
    },
    CACHE_TTL_HEADERS
  ).finalMessage();

  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };

  if (response.stop_reason === 'max_tokens') {
    // A truncated read is missing its tail, and a missing question later reads
    // as "never asked". Refused outright rather than returned partial.
    throw new ApplicationExtractionError(
      { reason: 'truncated', detail: 'the model ran out of output before finishing the question set' },
      { usage, model }
    );
  }

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a structured extraction');
  }
  const output = toolUse.input as { is_application?: unknown; insurer?: unknown; pairs?: unknown };

  if (output.is_application !== true) {
    throw new ApplicationExtractionError(
      { reason: 'not_application', detail: 'the model judged this document not to be an application record' },
      { usage, model }
    );
  }
  const rawPairs = Array.isArray(output.pairs) ? output.pairs : [];
  const verified = verifyExtractedPairs(text, rawPairs);

  if (verified.pairs.length === 0) {
    throw new ApplicationExtractionError(
      {
        reason: 'nothing_extracted',
        detail: `the model returned ${verified.returned} pair(s), none verifiable against the document`,
      },
      { usage, model }
    );
  }
  // A reading where the document disowns much of what the model said is not a
  // reading — it is a different document being remembered. Half is the line:
  // real extractions lose the odd pair to an OCR quirk, not dozens.
  if (verified.dropped > verified.pairs.length) {
    throw new ApplicationExtractionError(
      {
        reason: 'too_many_unverified',
        detail:
          `${verified.dropped} of ${verified.returned} pair(s) could not be found in the document text, ` +
          'so the reading cannot be trusted',
      },
      { usage, model }
    );
  }

  return {
    pairs: verified.pairs,
    insurer:
      typeof output.insurer === 'string' && output.insurer.trim() !== '' ? output.insurer.trim() : null,
    dropped: verified.dropped,
    usage,
    model,
  };
}

import { config } from '../config.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { CACHE_TTL_HEADERS } from './scoring.js';
import {
  parseApplication,
  fingerprintQuestions,
  normaliseForDetection,
  parseCoverage,
  type ParseConfig,
  type ParseStrategy,
  type ParsedApplication,
} from './application-pdf.js';
import {
  deriveSearchTerms,
  absenceIsMeaningful,
  defaultCheckMode,
  defaultRiskDirection,
  type QuestionCheckMode,
  type RiskDirection,
} from './reconciliation.js';
import {
  answerCategoryOf,
  EMAIL_PATTERN,
  UK_POSTCODE_PATTERN,
  type AnswerCategory,
} from './application-redaction.js';

// ============================================================
// Learning a document profile.
//
// THE MODEL PRODUCES THE PARSE CONFIG, NOT THE PARSED DATA.
//
// It would be simpler to hand a model the PDF and ask for the fifty questions
// and answers. It would also be worse in every way that matters:
//
//   * Cost. Extracting the config once per insurer is a few pence forever;
//     extracting the answers is a few pence on every one of ~180 sales a month.
//   * Reproducibility. A flag against an adviser must be explainable. Parsed
//     output from a stored config is deterministic and re-derivable; model
//     output is neither.
//   * Verifiability. A config can be checked by running it and inspecting the
//     result. A list of extracted answers can only be checked by reading the
//     document yourself, which is the work we were trying to avoid.
//
// So this runs once when an unrecognised document appears, and again only when
// the fingerprint says the insurer changed their question set. Everything else
// is deterministic code in application-pdf.ts.
// ============================================================

const DEFAULT_LEARNER_MODEL = CLAUDE_MODELS.HAIKU;

// ============================================================
// Redacting a document BEFORE it is learned from.
//
// verifyProposal (below) runs the proposed config against the real, unredacted
// rawText — that is what makes the profile trustworthy. But the model that
// PROPOSES the config only ever needs to see labels, delimiters and section
// boundaries: it is describing how to read the document, not what is in it
// (see the module comment above). What was actually happening was the whole
// document going to Claude unredacted — up to HEAD_CHARS + TAIL_CHARS of an
// insurance application, which is a name, a date of birth, a home address, a
// policy number and, for anything underwritten, the health disclosures
// themselves. None of that is needed to describe a document's shape.
//
// This mirrors the redaction a transcript already gets before it is stored or
// scored (typed placeholders in place of values — see application-redaction.ts
// and transcription.ts's Deepgram categories) applied to the other side of a
// reconciliation: the document rather than the call. It runs unconditionally,
// not behind a tenant's transcript redaction settings, because this protects
// one specific model call rather than implementing the tenant's DPIA.
// ============================================================

/** Values the parser itself prints to mean "no answer given" — not PII, and
 *  worth the model seeing intact so it can propose unansweredMarkers. */
const NON_PII_MARKER =
  /^(unanswered|not\s*answered|n\/?a|none|not\s*provided|no\s*answer|unknown|not\s*applicable|not\s*given|blank|-)$/i;

/** A label naming an identifier the insurer issued for this sale — a policy,
 *  plan, application, quote or membership number. Not itself personal data,
 *  but it identifies one customer's paperwork as precisely as a name would. */
const POLICY_LABEL = /\b(?:polic(?:y)?|plan|application|quote|membership)\s*(?:no\.?|number|ref(?:erence)?)\b/i;

/** A label whose value is (or plausibly is) a person's name — broader than
 *  answerCategoryOf's, which is scoped to the narrower set of exact labels a
 *  CONFIRMED profile's fields carry. Raw document text says "Your name",
 *  "Adviser name", "Next of kin name" — none of which that stricter matcher
 *  claims. Product/company/scheme names are excluded because they are not a
 *  person's. */
const NON_PERSONAL_NAME_LABEL = /\b(company|product|plan|scheme|policy|fund|employer|business|firm)\s+name\b/i;
/** A label that names a PERSON by their role rather than by saying "name" at
 *  all — "Applicant: Mr Sample Applicant", "Person covered: ...". Whatever
 *  answer sits against one of these identifies whose paperwork this is. */
const PERSONAL_ROLE_LABEL =
  /^(applicant|customer|client|policyholder|adviser|advisor|account\s*holder|payer|next\s+of\s+kin|beneficiary|life\s+assured|person\s+covered)$/i;
function looksLikePersonalNameLabel(label: string): boolean {
  if (PERSONAL_ROLE_LABEL.test(label.trim())) return true;
  return /\bname\b/i.test(label) && !NON_PERSONAL_NAME_LABEL.test(label);
}

/** Strip a leading possessive so "Your DOB" and "The applicant's address" read
 *  as the bare field answerCategoryOf already recognises. */
const LABEL_POSSESSIVE_PREFIX = /^\s*(your|the|applicant'?s?|customer'?s?|client'?s?)\s+/i;

/** The literal that separates a question from its answer in the question_answer
 *  strategy's dominant real phrasing ("Your answer(s):", "Your answer:"). Every
 *  value that follows one — health disclosures included — is masked the same
 *  way regardless of what the question was about, because the point is the
 *  document's shape, not its content. */
const ANSWER_DELIMITER_LABEL = /^\s*(?:your\s+)?(?:answer(?:\(s\))?|response)\s*$/i;

const CATEGORY_TAGS: Partial<Record<AnswerCategory, string>> = {
  email_address: 'EMAIL_ADDRESS',
  location_address: 'LOCATION_ADDRESS',
  dob: 'DOB',
  numbers: 'PHONE_NUMBER',
};

/** Which typed tag, if any, a "Label:" line's value should be replaced with. */
function resolveLabelTag(label: string): string | null {
  if (ANSWER_DELIMITER_LABEL.test(label)) return 'VALUE';
  if (POLICY_LABEL.test(label)) return 'POLICY_NUMBER';
  if (looksLikePersonalNameLabel(label)) return 'NAME';
  const normalised = label.replace(LABEL_POSSESSIVE_PREFIX, '').trim();
  const category = answerCategoryOf(normalised) ?? answerCategoryOf(label);
  return category && category !== 'name' ? (CATEGORY_TAGS[category] ?? null) : null;
}

/** A line that continues the PREVIOUS line's value, for a field extraction has
 *  wrapped onto its own line (a multi-line address is the case that matters —
 *  "1 Sample Street\nSampletown\nAB12 3CD"). Anything that looks like the start
 *  of something else — blank, a fresh "Label:" line, a question, or an
 *  ALL-CAPS heading — ends the value instead. */
function looksLikeContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.includes(':')) return false;
  if (trimmed.endsWith('?')) return false;
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase()) return false;
  return true;
}

/**
 * Mask "Label: value" lines (label_value strategy, and the inline identity
 * fields at the top of a question_answer pack) and the value that follows a
 * "Your answer(s):" delimiter (question_answer strategy), wherever the label
 * says the value is personal.
 *
 * Line-based rather than a single regex, because a masked value's extent is
 * not always the rest of the line — an address wraps onto lines with no label
 * of their own, and has to be told apart from the next real field.
 */
function redactLabelledLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = /^([^\n:]{1,80}):[ \t]*(.*)$/.exec(line);
    if (!match) {
      out.push(line);
      i++;
      continue;
    }
    const rawLabel = match[1];
    const rawValue = match[2];
    const tag = resolveLabelTag(rawLabel.trim());
    if (!tag) {
      out.push(line);
      i++;
      continue;
    }
    const inlineValue = rawValue.trim();
    const maskInline = inlineValue !== '' && !NON_PII_MARKER.test(inlineValue);
    out.push(maskInline ? `${rawLabel}: [${tag}]` : line);
    i++;

    // A wrapped value is only expected for an address, or a label whose value
    // was pushed onto the next line entirely (the common "Label:\nvalue" shape
    // seen from two-column extraction).
    if (tag === 'LOCATION_ADDRESS' || inlineValue === '') {
      let consumed = false;
      while (i < lines.length && looksLikeContinuationLine(lines[i]!)) {
        consumed = true;
        i++;
      }
      if (consumed) out.push(`[${tag}]`);
    }
  }
  return out.join('\n');
}

/**
 * Mask the quote-portal export's answer lines — "<timestamp> - <value>
 * (<name recorded by>)", with the value sometimes wrapping onto the line
 * before the attribution. Both the disclosed value and the name of whoever
 * recorded it are masked; the timestamp is kept, because it carries no
 * identity and the model needs the surrounding shape intact to write a
 * three-group answer_line_pattern.
 *
 * Two passes because an attribution can be missing (the withdrawn-disclosures
 * section) as well as present, and a single pattern permissive enough to catch
 * both ends up unable to tell "no attribution on this line" from "attribution
 * two lines down" — see PORTAL_WITHDRAWN_SECTION in application-pdf.fixtures.ts
 * for why both shapes are real.
 */
function redactPortalAnswerLines(text: string): string {
  const TIMESTAMP = String.raw`\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s+\d{1,2}:\d{2}`;
  // Attributed, possibly wrapping one line before the "(name)": bounded to at
  // most one extra line, which is the only wrap real exports have produced —
  // an unbounded scan would risk reaching across unrelated content to the next
  // attribution in the document. That extra line must not itself start a new
  // timestamped entry, or two consecutive amendments to the same answer (the
  // portal keeps every edit) collapse into one match and one of them vanishes
  // from what the model sees instead of being masked in place.
  const attributed = new RegExp(
    `^(${TIMESTAMP})\\s*-\\s*([^\\n]*(?:\\n(?!${TIMESTAMP})[^\\n]*)?)\\s*\\(([^)\\n]*)\\)[ \\t]*$`,
    'gm'
  );
  let out = text.replace(attributed, (_m, ts: string) => `${ts} - [VALUE] ([NAME])`);
  // Unattributed: only reached for lines the pass above did not already
  // replace, which the marker text it left behind makes checkable. The
  // lookahead sits directly after the literal "-", before either side's
  // \s*, because a \s* AFTER it is backtrackable — an engine that cannot
  // satisfy the rest of the pattern will give the lookahead's position back
  // one whitespace character at a time until it no longer lands on
  // "[VALUE]", defeating the guard silently.
  const unattributed = new RegExp(`^(${TIMESTAMP})\\s*-(?!\\s*\\[VALUE\\])\\s*(.+)$`, 'gm');
  out = out.replace(unattributed, (_m, ts: string) => `${ts} - [VALUE]`);
  return out;
}

/** "Your plan number 900000001" — the same identifier POLICY_LABEL catches on
 *  a "Label:" line, but stated inline in a sentence with no colon at all. */
function redactInlinePolicyNumbers(text: string): string {
  return text.replace(
    /\b((?:polic(?:y)?|plan|application|quote|membership)\s*(?:no\.?|number|ref(?:erence)?))\b[ \t]*:?[ \t]*([A-Z0-9][A-Z0-9\-/]{3,})/gi,
    (_m, label: string) => `${label} [POLICY_NUMBER]`
  );
}

/**
 * Redact values from a raw document's text before any of it is sent to Claude
 * to propose a parse profile.
 *
 * Deliberately over-inclusive rather than precise: this text is discarded the
 * moment the model call returns (verifyProposal re-parses the untouched
 * rawText — see learnDocumentProfile), so a value masked that did not strictly
 * need to be costs nothing. A value that should have been masked and was not
 * costs a customer's personal data landing in a third party's logs.
 */
export function redactValuesForLearning(rawText: string): string {
  let text = redactPortalAnswerLines(rawText);
  text = redactLabelledLines(text);
  text = redactInlinePolicyNumbers(text);
  // Freestanding safety nets for values that reached here without a
  // recognisable label at all — the same shapes application-redaction.ts
  // scrubs out of a contaminated field on the parsed side of a reconciliation.
  text = text.replace(EMAIL_PATTERN, '[EMAIL_ADDRESS]');
  text = text.replace(UK_POSTCODE_PATTERN, '[LOCATION_ZIP]');
  return text;
}

/**
 * How much of the document the model sees. The structure is established in the
 * opening pages and the boundary at the end; the middle is fifty repetitions of
 * a pattern already visible in the first few. Sampling head and tail keeps the
 * call cheap without hiding the section boundaries the config depends on.
 */
const HEAD_CHARS = 9000;
const TAIL_CHARS = 3000;

export function sampleForLearning(rawText: string): string {
  if (rawText.length <= HEAD_CHARS + TAIL_CHARS) return rawText;
  return (
    rawText.slice(0, HEAD_CHARS) +
    '\n\n[…document truncated for analysis…]\n\n' +
    rawText.slice(-TAIL_CHARS)
  );
}

export interface ProfileProposal {
  insurer: string;
  product: string | null;
  strategy: ParseStrategy;
  detect_patterns: string[];
  parse_config: ParseConfig;
  /** The model's own account of how it read the document, for the reviewer. */
  notes: string | null;
}

export interface ProfileQuestion {
  order: number;
  question: string;
  guidance: string | null;
  choices: string[];
  /**
   * Whether "we found none of this question's terms" may be reported as "the
   * adviser did not ask it". Defaulted conservatively from the measured
   * redaction behaviour and meant to be confirmed by a human — see
   * services/reconciliation.ts.
   */
  absence_meaningful: boolean;
  /**
   * How this field is checked. Stamped explicitly at proposal time rather than
   * left to the reader's default, so what a human sees on the review page is
   * what will actually be applied, and so a later change to the heuristic cannot
   * silently re-decide a format somebody already approved.
   */
  check_mode: QuestionCheckMode;
  /**
   * Which way a quantity here moves the risk, for telling an over-declaration
   * from a non-disclosure. Stamped at proposal time for the same reason
   * check_mode is: a later change to the heuristic must not silently re-decide a
   * format somebody already approved — and here the stakes run the other way, so
   * a widened default could quietly retire findings on live profiles.
   */
  risk_direction: RiskDirection;
}

export interface ValidationProblem {
  severity: 'error' | 'warning';
  message: string;
}

export interface LearnedProfile {
  proposal: ProfileProposal;
  parsed: ParsedApplication;
  questions: ProfileQuestion[];
  fingerprint: string;
  problems: ValidationProblem[];
  /** False when any problem is an error — the profile must not be stored active. */
  usable: boolean;
  /**
   * Whether the document actually asks the customer anything, as opposed to
   * restating what was sold. This is what makes one candidate in a pack worth
   * more than another, so it is decided once here rather than re-derived by
   * every caller that needs to choose between them.
   */
  hasDisclosureQuestions: boolean;
}

const PROFILE_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    insurer: { type: 'string', description: 'The insurer that issued this document, e.g. "Royal London"' },
    product: { type: ['string', 'null'], description: 'The product name if stated, e.g. "Personal Menu Plan"' },
    strategy: {
      type: 'string',
      enum: ['question_answer', 'label_value', 'question_marker'],
      description:
        'question_answer when the document repeats <question> then a fixed answer delimiter then the answer. label_value when it is a flat sheet of "Label: value" pairs. question_marker when each question line ends with a stranded column header and its answers appear BEFORE it, one per line, with a timestamp and the name of whoever recorded them.',
    },
    detect_patterns: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Two to four exact literal strings that together identify this document type and would NOT all appear in another document from the same firm (especially not in a suitability report). Do not include customer-specific values.',
    },
    answer_delimiter: {
      type: ['string', 'null'],
      description: 'question_answer only: the exact literal that separates a question from its answer, e.g. "Your answer(s):"',
    },
    section_start: {
      type: ['string', 'null'],
      description:
        'Exact literal marking where the application begins within the wider pack. Null if the PDF is a single document.',
    },
    section_end: {
      type: ['string', 'null'],
      description: 'Exact literal marking where the application ends, i.e. where the next document starts.',
    },
    strip_patterns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Regex sources (JS syntax) matching repeated page footers or boilerplate lines to remove.',
    },
    choice_bullet: { type: ['string', 'null'], description: 'The bullet character introducing a multiple-choice option.' },
    unanswered_markers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Literal values the insurer prints to mean no answer was given, e.g. "Unanswered".',
    },
    labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'label_value only: every field label on the sheet, exactly as printed, without the colon.',
    },
    value_terminators: {
      type: 'array',
      items: { type: 'string' },
      description:
        'label_value only: section headings and boilerplate that end a value without being labels themselves.',
    },
    question_marker: {
      type: ['string', 'null'],
      description:
        'question_marker only: the exact literal every question line ends with — usually a column header the PDF extraction leaves stranded there.',
    },
    answer_line_pattern: {
      type: ['string', 'null'],
      description:
        'question_marker only: a JS regex source matching ONE recorded answer line, with three capture groups in this order: (1) the timestamp, (2) the answer value, (3) the name of whoever recorded it.',
    },
    options_prefix: {
      type: ['string', 'null'],
      description: 'question_marker only: the literal introducing the list of choices offered.',
    },
    notes: { type: ['string', 'null'], description: 'Anything a human reviewer should know about this document.' },
  },
  required: ['insurer', 'product', 'strategy', 'detect_patterns', 'notes'],
};

function buildLearningPrompt(sample: string): { cached: string; dynamic: string } {
  const cached = `You are analysing an insurance application document so it can be parsed
DETERMINISTICALLY, in code, for every future sale. You are not extracting the
answers — you are describing how to read the document.

Return a parse configuration via the submit_profile tool.

What matters:

1. STRATEGY. "question_answer" if the document repeats a question followed by a
   fixed literal delimiter and then the answer. "label_value" if it is a flat
   summary of "Label: value" pairs. "question_marker" if it is a portal export
   where each question line ends with a stranded column header and the answers
   appear BEFORE the question they belong to, each on its own line with a
   timestamp and the name of whoever recorded it. Read the order carefully:
   answers preceding their question is the distinguishing feature, and it is
   easy to mistake for question_answer at a glance.

2. EXACT LITERALS. Every string you return is used verbatim for indexOf or as a
   regex. Copy them character for character from the document, including
   punctuation and capitalisation. A near-miss produces silent mis-parsing.

3. SECTION BOUNDARIES. These packs bundle several documents: a covering letter, a
   medical-consent form, a blank confirmation form, the underwriting quote, and
   the firm's own commission schedule. Only the application itself may be read.
   section_start and section_end must exclude ALL of the others. Getting this
   wrong leaks the firm's commission and the underwriting decision into the
   compliance record.

4. NO CUSTOMER DATA. detect_patterns identify the document TYPE. Never use a
   customer's name, policy number, date or address — those differ per sale and
   would match nothing on the next one.

5. DETECT PATTERNS MUST DISCRIMINATE. All of them must be present for a match.
   The firm's own suitability report mentions the same product and contains
   customer and health detail, so it looks similar. Choose literals that appear
   in the insurer's application and nowhere else.`;

  const dynamic = `Document text (may be truncated in the middle):\n\n${sample}`;
  return { cached, dynamic };
}

/**
 * Ask a model to describe how to parse an unrecognised document, then verify the
 * description by actually parsing with it.
 *
 * The verification is the point: a proposal that does not produce a sane parse
 * is rejected here rather than being stored and quietly mis-reading every future
 * sale.
 */
export async function learnDocumentProfile(
  rawText: string,
  modelOverride: string | null = null
): Promise<{
  learned: LearnedProfile;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}> {
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env - needed for profile learning');
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const model = modelOverride ?? DEFAULT_LEARNER_MODEL;
  // Only the redacted sample leaves the process. verifyProposal below re-parses
  // the real rawText, so nothing about the parse's accuracy depends on this.
  const prompt = buildLearningPrompt(sampleForLearning(redactValuesForLearning(rawText)));

  const response = await client.messages.stream(
    {
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt.cached },
            { type: 'text', text: prompt.dynamic },
          ],
        },
      ],
      tools: [
        {
          name: 'submit_profile',
          description: 'Describe how to parse this application document',
          input_schema: PROFILE_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'submit_profile' },
    },
    CACHE_TTL_HEADERS
  ).finalMessage();

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a structured document profile');
  }

  const proposal = toProposal(toolUse.input as Record<string, unknown>);
  const learned = verifyProposal(rawText, proposal);

  return {
    learned,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    model,
  };
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Normalise the model's raw tool input into a ProfileProposal. */
export function toProposal(raw: Record<string, unknown>): ProfileProposal {
  const strategy: ParseStrategy =
    raw.strategy === 'label_value' || raw.strategy === 'question_marker'
      ? raw.strategy
      : 'question_answer';
  const parse_config: ParseConfig = {};

  const delimiter = asStringOrNull(raw.answer_delimiter);
  if (delimiter) parse_config.answerDelimiter = delimiter;
  const start = asStringOrNull(raw.section_start);
  if (start) parse_config.sectionStart = start;
  const end = asStringOrNull(raw.section_end);
  if (end) parse_config.sectionEnd = end;
  const bullet = asStringOrNull(raw.choice_bullet);
  if (bullet) parse_config.choiceBullet = bullet;

  const strip = asStringArray(raw.strip_patterns);
  if (strip.length) parse_config.stripPatterns = strip;
  const unanswered = asStringArray(raw.unanswered_markers);
  if (unanswered.length) parse_config.unansweredMarkers = unanswered;
  const labels = asStringArray(raw.labels);
  if (labels.length) parse_config.labels = labels;
  const terminators = asStringArray(raw.value_terminators);
  if (terminators.length) parse_config.valueTerminators = terminators;
  const marker = asStringOrNull(raw.question_marker);
  if (marker) parse_config.questionMarker = marker;
  const answerLine = asStringOrNull(raw.answer_line_pattern);
  if (answerLine) parse_config.answerLinePattern = answerLine;
  const optionsPrefix = asStringOrNull(raw.options_prefix);
  if (optionsPrefix) parse_config.optionsPrefix = optionsPrefix;

  return {
    insurer: asStringOrNull(raw.insurer) ?? 'Unknown insurer',
    product: asStringOrNull(raw.product),
    strategy,
    detect_patterns: asStringArray(raw.detect_patterns),
    parse_config,
    notes: asStringOrNull(raw.notes),
  };
}

/**
 * Run the proposed config and judge the result.
 *
 * Errors block the profile from being stored; warnings are surfaced to whoever
 * confirms it. The commission check is an error rather than a warning because a
 * config that leaks the firm's earnings into the compliance record is a
 * data-protection problem, not a quality one.
 */
/**
 * Does this compile, and does it capture the three things the parser reads?
 *
 * Counted with the standard `source + '|'` trick: the alternation makes the whole
 * pattern match the empty string, so the result array reveals the group count
 * without needing input that actually matches.
 */
export function isUsableAnswerPattern(source: string): boolean {
  try {
    const groups = (new RegExp(`${source}|`).exec('')?.length ?? 1) - 1;
    return groups >= 3;
  } catch {
    return false;
  }
}

// A date, a clock time, or a long unbroken digit run. Anything matching belongs
// to one sale rather than to the document type.
//
// The digit rule is deliberately NOT word-bounded, so it catches a policy number
// welded to a prefix ("EPH000001") — which is exactly how insurers write them.
// Six is the threshold because a document's own form code is the pattern most
// worth keeping and reads as short groups: MetLife's "COMP 3094.04 NOV2023" is a
// perfectly good detect pattern and must survive this.
const SALE_SPECIFIC = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}:\d{2}\b|\d{6,}/;

// "Unknown insurer" is toProposal's own fallback when the model returns nothing,
// so it has to be in here or the guard misses the commonest case of all.
const PLACEHOLDER =
  /^\s*(<?unknown>?(\s+(insurer|provider|product))?|n\/?a|none|unidentified|not an? .*|tbc|\?+)\s*$/i;

export function isPlaceholder(value: string | null | undefined): boolean {
  return !value || !value.trim() || PLACEHOLDER.test(value);
}

// Vocabulary that appears when a document asks the customer to disclose
// something, and does NOT appear on a summary of what was sold.
//
// Deliberately excludes the words a summary sheet also uses. "Occupation" was
// the trap: it reads like a health-and-lifestyle question, and MetLife's summary
// carries both "Occupation:" and "Occupational eligibility:", so including it
// let the exact document this guard exists to catch sail through. Same reasoning
// drops travel, driving, sport and hours-per-week — all of them appear as
// rating factors on documents that ask nothing.
const DISCLOSURE_TERMS =
  /\b(smok|tobacco|alcohol|drink|drug|height|tall|weigh|diagnos|symptom|treatment|medication|prescrib|doctor|gp\b|hospital|surger|illness|disease|disabilit|cancer|diabet|heart|stroke|asthma|depress|anxiet|mental health|famil(y|ial) history|hazardous|convict)/i;

/**
 * Does this read as a set of questions put to the customer, or as a summary of
 * what was sold?
 *
 * The test is deliberately structural before it is lexical: a real question set
 * asks things, so it contains interrogatives. A summary of key facts is a list
 * of noun-phrase labels — "Name", "Address", "Monthly premium", "No. of Units".
 * Either an interrogative or disclosure vocabulary is enough to pass.
 */
export function looksLikeDisclosureSet(questions: string[]): boolean {
  if (questions.length === 0) return false;
  const interrogative = questions.some(
    (q) => q.includes('?') || /^\s*(do|does|did|have|has|are|is|was|were|will|would|can|could|how|what|which|when|where|why|please (tell|choose|confirm|select))\b/i.test(q)
  );
  return interrogative || questions.some((q) => DISCLOSURE_TERMS.test(q));
}

/**
 * Alternatives to the configuration the model proposed.
 *
 * The model describes a document it has seen once, and it describes it too
 * precisely. The clearest case: it wrote an answer pattern requiring a trailing
 * "(adviser name)" where the built-in default already treats that as optional.
 * Every answer in the withdrawn-disclosures section of a real application lacks
 * the name, so the stricter pattern folded those answers into the question text
 * and lost one question entirely.
 *
 * Rather than curate rules for that class of mistake, the proposal is treated as
 * one candidate among several and measured. Dropping an over-specified field
 * falls back to a default already tested against every format we hold, so a
 * model being too specific can no longer cost questions.
 */
function candidateConfigs(proposal: ProfileProposal): ParseConfig[] {
  const base = proposal.parse_config;
  const out: ParseConfig[] = [base];
  if (base.answerLinePattern) {
    const { answerLinePattern: _drop, ...rest } = base;
    out.push(rest);
  }
  if (base.optionsPrefix) {
    const { optionsPrefix: _drop, ...rest } = base;
    out.push(rest);
    if (base.answerLinePattern) {
      const { answerLinePattern: _a, optionsPrefix: _o, ...bare } = base;
      out.push(bare);
    }
  }
  return out;
}

export function verifyProposal(rawText: string, proposal: ProfileProposal): LearnedProfile {
  const problems: ValidationProblem[] = [];

  // Whichever candidate configuration recovers the most of the document wins.
  // The model's own proposal is first, so a tie keeps it — this only overrides
  // it where doing so demonstrably finds more.
  let parsed = parseApplication(rawText, proposal.strategy, proposal.parse_config);
  const proposedCount = parsed.pairs.length;
  for (const candidate of candidateConfigs(proposal).slice(1)) {
    const alt = parseApplication(rawText, proposal.strategy, candidate);
    if (alt.pairs.length > parsed.pairs.length) {
      parsed = alt;
      proposal.parse_config = candidate;
    }
  }
  if (parsed.pairs.length > proposedCount) {
    problems.push({
      severity: 'warning',
      message:
        'The proposed parse rules were narrower than the document needed, so a more tolerant ' +
        `default was used instead — it reads ${parsed.pairs.length} records rather than ${proposedCount}.`,
    });
  }

  // Did we get everything the document says is there? The parse cannot answer
  // that about itself, so the document's own markers are counted independently.
  // This is what turns silent loss into a visible failure, and it works for any
  // insurer whose format has a countable marker — including one nobody has
  // configured anything for.
  const coverage = parseCoverage(rawText, proposal.strategy, proposal.parse_config, parsed.pairs.length);
  if (coverage.ratio !== null && coverage.ratio < 0.95) {
    const missing = (coverage.expected ?? 0) - parsed.pairs.length;
    // Which ones, for label_value. "22 of 43 were read" tells a reviewer the
    // parse is broken; naming the questions it dropped tells them what stops
    // being checked, and on the two real cases those were the entire health
    // disclosure sections while the policy and contact fields came through
    // perfectly — a difference invisible in a ratio.
    const unread =
      proposal.strategy === 'label_value'
        ? (proposal.parse_config.labels ?? []).filter(
            (l) => !parsed.pairs.some((p) => p.question.toLowerCase() === l.toLowerCase())
          )
        : [];
    problems.push({
      severity: missing > 2 ? 'error' : 'warning',
      message:
        `The document contains ${coverage.expected} records but only ${parsed.pairs.length} were read — ` +
        `${missing} would be missed on every sale of this format. A question that is not extracted is ` +
        'never checked against the call, so this cannot be accepted as it stands.' +
        (unread.length
          ? ` Not read: ${unread.slice(0, 6).map((l) => JSON.stringify(l)).join(', ')}` +
            (unread.length > 6 ? ` and ${unread.length - 6} more.` : '.')
          : ''),
    });
  }

  if (proposal.detect_patterns.length < 2) {
    problems.push({
      severity: 'error',
      message:
        'Fewer than two detect patterns. A single pattern is too weak to distinguish the application from the suitability report that sits beside it.',
    });
  }
  // Tested exactly as matchProfile will test it at match time. Anything looser
  // here would accept a profile that never matches a document; anything
  // stricter would reject one that would have matched perfectly well.
  const haystack = normaliseForDetection(rawText);
  for (const p of proposal.detect_patterns) {
    if (!haystack.includes(normaliseForDetection(p))) {
      problems.push({ severity: 'error', message: `Detect pattern not present in the document: "${p}"` });
    }
  }

  if (proposal.strategy === 'question_answer' && !proposal.parse_config.answerDelimiter) {
    problems.push({ severity: 'error', message: 'question_answer strategy with no answer delimiter.' });
  }
  if (proposal.strategy === 'label_value' && (proposal.parse_config.labels?.length ?? 0) === 0) {
    problems.push({ severity: 'error', message: 'label_value strategy with no labels.' });
  }
  if (proposal.strategy === 'question_marker') {
    if (!proposal.parse_config.questionMarker) {
      problems.push({ severity: 'error', message: 'question_marker strategy with no question marker.' });
    }
    // No answer pattern is fine — the parser falls back to the observed portal
    // format, and demanding the model restate it invites a subtly wrong regex
    // where the default would have worked. A pattern that IS given must hold up.
    if (
      proposal.parse_config.answerLinePattern &&
      !isUsableAnswerPattern(proposal.parse_config.answerLinePattern)
    ) {
      // An uncompilable or under-grouped pattern is caught here rather than at
      // parse time on a live sale: the parser would see no answers at all and
      // every question would read as unanswered, which is indistinguishable
      // from an adviser having skipped the entire application.
      problems.push({
        severity: 'error',
        message:
          'The answer line pattern is not a valid regex with three capture groups (timestamp, value, recorded-by).',
      });
    }
  }

  if (parsed.empty) {
    problems.push({
      severity: 'error',
      message: 'The proposed configuration parsed nothing. Either the document has no question set, or the config is wrong.',
    });
  }

  // Did the section boundaries hold? These strings belong to the OTHER documents
  // in the pack and must never reach the parsed output.
  const serialised = JSON.stringify(parsed.pairs).toLowerCase();
  for (const leak of ['commission', 'we\'ll pay', 'underwriting decision']) {
    if (serialised.includes(leak)) {
      problems.push({
        severity: 'error',
        message: `Parsed output contains "${leak}" — the section boundaries are letting another document in the pack through.`,
      });
    }
  }

  // A "question" hundreds of characters long means block splitting has merged
  // several, which corrupts both the wording and the fingerprint.
  const overlong = parsed.pairs.filter((p) => p.question.length > 300);
  if (overlong.length > 0) {
    problems.push({
      severity: 'warning',
      message: `${overlong.length} question(s) over 300 characters — block boundaries may be merging questions.`,
    });
  }

  const unanswered = parsed.pairs.filter((p) => p.answer === null).length;
  if (parsed.pairs.length > 0 && unanswered === parsed.pairs.length) {
    problems.push({
      severity: 'error',
      message:
        proposal.strategy === 'question_marker'
          ? 'Every question parsed with no answer — the answer line pattern is probably wrong.'
          : 'Every question parsed with no answer — the answer delimiter is probably wrong.',
    });
  }

  if (proposal.strategy !== 'label_value' && parsed.pairs.length < 5) {
    problems.push({
      severity: 'warning',
      message: `Only ${parsed.pairs.length} question(s) found. If this is a summary sheet rather than a full application, label_value is likely the right strategy.`,
    });
  }

  if (parsed.pairs.length > 0 && !looksLikeDisclosureSet(parsed.pairs.map((p) => p.question))) {
    // A warning, not an error, and the distinction is deliberate.
    //
    // Reconciling a summary of key facts IS worth doing: whether the cover
    // amount, the units and the date of birth on the submitted document match
    // what was said on the call are real checks, and label_value exists to make
    // them. Blocking the profile would refuse a document this module was built
    // to read.
    //
    // But a clean result on such a document means something much narrower than
    // it appears. Nothing on it asks the customer to disclose anything, so a
    // green panel cannot be evidence that the health answers matched — there
    // were none. Whoever confirms the profile is the last person able to notice
    // that, so they are told plainly here.
    problems.push({
      severity: 'warning',
      message:
        'No disclosure question found — every item reads as an administrative field (name, ' +
        'address, cover amount, premium). Reconciling these is still worthwhile, but a clean ' +
        'result on this format is NOT evidence that health or lifestyle answers matched, ' +
        'because the document does not ask any.',
    });
  }

  // A detect pattern carrying this sale's own data can only ever match this one
  // document, so a profile keeping it would be confirmed and then match nothing
  // ever again. Observed repeatedly on real proposals: a timestamp lifted
  // straight off the page.
  //
  // Dropped rather than fatal. Whether the model reaches for a timestamp varies
  // run to run on the SAME document — of eight portal exports it did it on three
  // — so failing the proposal makes a good document's fate a coin toss. The
  // remaining patterns are the ones that actually identify the document type,
  // and two of them is the bar the whole check exists to enforce, so if two
  // survive there is nothing wrong with the result.
  const saleSpecific = proposal.detect_patterns.filter((p) => SALE_SPECIFIC.test(p));
  if (saleSpecific.length > 0) {
    const kept = proposal.detect_patterns.filter((p) => !SALE_SPECIFIC.test(p));
    if (kept.length >= 2) {
      proposal.detect_patterns = kept;
      problems.push({
        severity: 'warning',
        message:
          `Dropped ${saleSpecific.length} detect pattern(s) carrying data specific to this sale ` +
          `(${saleSpecific.map((p) => `"${p.trim()}"`).join(', ')}). A pattern must appear on ` +
          `every document of this type. ${kept.length} pattern(s) remain, which is enough to identify it.`,
      });
    } else {
      problems.push({
        severity: 'error',
        message:
          `Detect pattern contains data specific to this sale: ${saleSpecific
            .map((p) => `"${p.trim()}"`)
            .join(', ')}. Removing it would leave fewer than two patterns, which is too weak ` +
          'to tell this document apart from the others in the pack.',
      });
    }
  }

  // A warning, and the reasoning is worth stating because the obvious choice is
  // wrong. insurer+product IS the unique key, so two unidentified formats would
  // collide — but only once they are ACTIVE, which is what the partial unique
  // index says. A proposal awaiting confirmation collides with nothing.
  //
  // Blocking here was tried and it was actively harmful: the broker portal
  // export does not name an insurer anywhere in it, because it is a quotation
  // request that spans several. Rejecting on that basis threw away the document
  // holding 39 real health disclosures and settled for a 7-field quote summary
  // instead. The check belongs where the collision actually happens — at
  // confirmation, which is also the only point where a person can supply the
  // name the document never had.
  if (isPlaceholder(proposal.insurer)) {
    problems.push({
      severity: 'warning',
      message:
        `The insurer is not named anywhere in this document (got "${proposal.insurer}"). ` +
        'Profiles are filed by insurer and product, so you will be asked to name it when ' +
        'you confirm this format.',
    });
  }

  const questions: ProfileQuestion[] = parsed.pairs.map((p) => ({
    order: p.order,
    question: p.question,
    guidance: p.guidance,
    choices: p.choices,
    absence_meaningful: absenceIsMeaningful(deriveSearchTerms(p.question, p.guidance)),
    check_mode: defaultCheckMode(p.question),
    risk_direction: defaultRiskDirection(p.question),
  }));

  return {
    proposal,
    parsed,
    questions,
    fingerprint: fingerprintQuestions(parsed.pairs.map((p) => p.question)),
    problems,
    usable: !problems.some((p) => p.severity === 'error'),
    hasDisclosureQuestions: looksLikeDisclosureSet(parsed.pairs.map((p) => p.question)),
  };
}

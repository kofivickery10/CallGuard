import { config } from '../config.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import { CACHE_TTL_HEADERS } from './scoring.js';
import {
  parseApplication,
  fingerprintQuestions,
  normaliseForDetection,
  type ParseConfig,
  type ParseStrategy,
  type ParsedApplication,
} from './application-pdf.js';
import { deriveSearchTerms, absenceIsMeaningful } from './reconciliation.js';

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
  const prompt = buildLearningPrompt(sampleForLearning(rawText));

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

export function verifyProposal(rawText: string, proposal: ProfileProposal): LearnedProfile {
  const problems: ValidationProblem[] = [];
  const parsed = parseApplication(rawText, proposal.strategy, proposal.parse_config);

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

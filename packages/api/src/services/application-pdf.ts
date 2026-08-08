import { createHash } from 'crypto';

// ============================================================
// Application PDF parsing for Data Forms reconciliation (Part B).
//
// The insurer returns the submitted application as a PDF on the CRM record.
// For a fully-underwritten product that document carries the insurer's complete
// question set alongside the answers given, which makes it the authoritative
// question list for that sale — it cannot drift out of date the way a
// hand-authored list does.
//
// Everything in this file is deterministic. No model is involved in parsing a
// document whose profile we already hold: the profile says how to read it, and
// the fingerprint says whether the profile is still valid. A model pass is only
// needed to LEARN a profile, which happens once per insurer/product and again
// only when the insurer changes their question set (see migration 080).
// ============================================================

export type ParseStrategy = 'question_answer' | 'label_value' | 'question_marker';

/**
 * How to read one insurer's document. Persisted as
 * capture_document_profiles.parse_config, so this shape is the contract.
 */
export interface ParseConfig {
  /**
   * Terminator that separates a question block from its answer, e.g. Royal
   * London's "Your answer(s):". question_answer strategy only.
   */
  answerDelimiter?: string;
  /**
   * Content markers bounding the application within the wider pack. A pack has
   * been observed to carry a covering letter, a medical-consent form, a blank
   * confirmation form, the underwriting quote and the firm's own commission
   * schedule around the application itself — none of which should be read.
   */
  sectionStart?: string;
  sectionEnd?: string;
  /** Regex sources for page footers and boilerplate to strip before parsing. */
  stripPatterns?: string[];
  /** Bullet character introducing a multiple-choice option. */
  choiceBullet?: string;
  /** Literal values the insurer uses to mean "no answer given". */
  unansweredMarkers?: string[];
  /**
   * question_marker strategy: the column label a question line ends with. In
   * the quote-portal export this is a tab followed by 'Q', the header of the
   * question column, which extraction leaves stranded at the end of each
   * question's text.
   */
  questionMarker?: string;
  /**
   * question_marker strategy: regex source matching one recorded answer, with
   * capture groups (1) timestamp (2) value (3) who recorded it. Answers PRECEDE
   * their question in the extracted text.
   */
  answerLinePattern?: string;
  /** question_marker strategy: prefix introducing the list of choices offered. */
  optionsPrefix?: string;
  /** label_value strategy: the labels to extract. */
  labels?: string[];
  /**
   * label_value strategy: further strings that end a value — section headings
   * and boilerplate that are not themselves labels. Without these, a value runs
   * on into the next heading ("Instructor - Other Eligibility Cover").
   */
  valueTerminators?: string[];
  /**
   * label_value strategy: backstop length for a value. The final label on a
   * sheet has no following label to stop it, so without a cap it swallows the
   * rest of the document — including the commission disclosure.
   */
  maxValueLength?: number;
}

/** One superseded answer, where the document records an audit trail. */
export interface AnswerRevision {
  value: string;
  timestamp: string | null;
  recordedBy: string | null;
}

export interface ParsedPair {
  order: number;
  /** The question as the insurer words it, or the field label. */
  question: string;
  /** Explanatory text the insurer prints under the question, if any. */
  guidance: string | null;
  /** Multiple-choice options offered, if any. */
  choices: string[];
  /** The submitted answer. null means the insurer recorded no answer. */
  answer: string | null;
  /** When the answer was recorded, where the document says. */
  answeredAt?: string | null;
  /** Who recorded it — the adviser, per the insurer's own audit trail. */
  recordedBy?: string | null;
  /**
   * Earlier answers that were replaced, oldest first.
   *
   * Some portals record every edit. An answer that was changed after the fact is
   * materially more interesting than one entered once: it is the difference
   * between a typo and an amendment, and it is evidence in its own right about
   * when the adviser knew what.
   */
  revisions?: AnswerRevision[];
}

export interface ParsedApplication {
  strategy: ParseStrategy;
  pairs: ParsedPair[];
  /** Hash of the ordered question wordings — cache key and drift detector. */
  fingerprint: string;
  /**
   * True when the document carried no question/answer structure at all. A
   * summary-only document (unit-based products) is a legitimate outcome, not a
   * parse failure, but reconciliation must report it rather than returning a
   * clean result against nothing.
   */
  empty: boolean;
}

/** Footers and identifiers common to every insurer pack we have seen. */
const DEFAULT_STRIP_PATTERNS = [
  // "page 4 of 16", "page 1 of 3"
  String.raw`^\s*page \d+ of \d+\s*$`,
  // Royal London document/run identifiers: "EX004A / 8178d5dd-…", "996860862 / I0R0"
  String.raw`^\s*[A-Z]{2}\d{3}[A-Z]? / [0-9a-f-]{8,}\s*$`,
  String.raw`^\s*\d{6,} / [A-Z0-9]+\s*$`,
  // Form codes printed in the margin: "P8B022", "COMP 3094.04 NOV2023"
  String.raw`^\s*[A-Z]\d[A-Z]\d{3}\s*$`,
  String.raw`^\s*COMP \d+\.\d+ [A-Z]{3}\d{4}\s*$`,
  // Regulatory boilerplate block that repeats on most pages.
  String.raw`^.*authorised (and regulated )?by the (Prudential|Financial|Central Bank).*$`,
  String.raw`^.*Registered (in England|office).*$`,
  String.raw`^.*Financial Services Register.*$`,
];

function stripBoilerplate(text: string, extraPatterns: string[] = []): string {
  const patterns = [...DEFAULT_STRIP_PATTERNS, ...extraPatterns].map(
    (p) => new RegExp(p, 'i')
  );
  return text
    .split('\n')
    .filter((line) => !patterns.some((re) => re.test(line)))
    .join('\n');
}

/**
 * Cut the application out of the surrounding pack.
 *
 * Deliberately content-based, never filename-based: the same insurer's pack has
 * been seen named both "Client review for <name>.pdf" and "Application Details
 * (5).pdf", and the firm's own suitability report sits alongside it in the CRM
 * looking superficially similar. Only the content distinguishes them.
 *
 * Returns the whole text when no markers are configured, so a single-document
 * PDF needs no section config at all.
 */
export function isolateSection(text: string, config: ParseConfig): string {
  let out = text;
  if (config.sectionStart) {
    const i = out.indexOf(config.sectionStart);
    if (i >= 0) out = out.slice(i + config.sectionStart.length);
  }
  if (config.sectionEnd) {
    const j = out.indexOf(config.sectionEnd);
    if (j >= 0) out = out.slice(0, j);
  }
  return out;
}

/**
 * Where does an answer stop and the next question begin?
 *
 * Isolated deliberately: it is the one genuinely heuristic step in this file,
 * and the exact whitespace a PDF text extractor emits varies by document. Keep
 * the rule here so it can be tuned against real extractor output without
 * touching the surrounding structure.
 *
 * An answer is the run of non-empty lines immediately following the delimiter,
 * ending at the first of: a blank line, an ALL-CAPS section heading, or a line
 * that reads as the start of a new question.
 */
function takeAnswerLines(lines: string[]): { answer: string[]; rest: string[] } {
  const answer: string[] = [];
  let i = 0;
  // The delimiter is followed by a line break, so the first line is empty.
  // Skip leading blanks before collecting, or every answer reads as absent.
  while (i < lines.length && lines[i]!.trim() === '') i++;
  for (; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '') break;
    // These guards apply even before anything has been collected. Where the
    // insurer left a question genuinely unanswered, the next question follows
    // the delimiter immediately, and without breaking here it would be consumed
    // as the answer — reading an unanswered question as answered, and losing the
    // question that followed. Answers do not end in '?' or ':', nor arrive as
    // all-caps headings, so nothing legitimate is lost.
    if (isSectionHeading(trimmed)) break;
    if (looksLikeQuestion(trimmed)) break;
    answer.push(trimmed);
  }
  return { answer, rest: lines.slice(i) };
}

/**
 * Section headings are printed in caps by every pack we have seen
 * ("WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR LIFESTYLE"). Require some
 * length so an acronym answer like "OK" or "HGV" is not mistaken for one.
 */
function isAllCapsLine(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

function isSectionHeading(line: string): boolean {
  if (line.length < 12) return false;
  const letters = line.replace(/[^A-Za-z]/g, '');
  if (letters.length < 8) return false;
  return letters === letters.toUpperCase();
}

/**
 * Which lines are section headings, judged with their neighbours in view.
 *
 * Headings wrap: "WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR OCCUPATION AND /
 * TRAVEL", and "HAVE YOU EVER HAD, OR DO YOU CURRENTLY HAVE, ANY OF THE /
 * FOLLOWING?". Judged alone, the continuation is a short all-caps fragment that
 * fails a length test — and because it ends in '?' or ':' it then reads as the
 * question, displacing the real one. That silently dropped the entire cancer
 * question from the parsed set.
 *
 * A short all-caps line is therefore a heading when it adjoins a full one. The
 * length floor still applies to isolated lines, so a genuine short answer like
 * "OK" is not mistaken for a heading.
 */
function markHeadings(lines: string[]): boolean[] {
  const full = lines.map((l) => isSectionHeading(l));
  return lines.map((line, i) => {
    if (full[i]) return true;
    if (!isAllCapsLine(line)) return false;
    return Boolean(full[i - 1]) || Boolean(full[i + 1]);
  });
}

function looksLikeQuestion(line: string): boolean {
  return line.endsWith('?') || line.endsWith(':');
}

const CHOICE_BULLET_DEFAULT = '●';

/**
 * Split a question block into its wording, the insurer's guidance, and any
 * multiple-choice options.
 *
 * The first meaningful line is the question. Bulleted lines are choices.
 * Whatever else remains is guidance — the insurer's clarifying prose, which is
 * worth keeping because it often defines the question's scope ("Answer Yes if
 * you have used them even on an occasional basis").
 */
function splitQuestionBlock(
  block: string,
  bullet: string
): { question: string; guidance: string | null; choices: string[] } {
  // Only the LAST blank-line-separated paragraph belongs to this question.
  // Earlier ones are leftovers carried over from the preceding page — the
  // insurer's own label/value preamble, section headings, adviser details — and
  // folding them in produces a "question" containing the customer's name, which
  // both corrupts the wording and makes the fingerprint differ between two sales
  // of the same product.
  const paragraphs = block
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const lastParagraph = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]! : '';

  // Heading flags are computed over the paragraph as written, before any
  // filtering, so a wrapped heading's continuation can still see the line it
  // continues.
  const rawLines = lastParagraph.split('\n').map((l) => l.trim());
  const headingFlags = markHeadings(rawLines);
  const lines = rawLines.filter((l, i) => l !== '' && !headingFlags[i]);

  const choices: string[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    if (line.startsWith(bullet)) {
      choices.push(line.slice(bullet.length).trim());
    } else {
      prose.push(line);
    }
  }

  // The question can wrap across lines; anything after the line that closes it
  // (with ? or :) is guidance. Where nothing closes, treat the first line as the
  // question so a malformed block still yields something identifiable.
  let closeIdx = prose.findIndex((l) => looksLikeQuestion(l));
  if (closeIdx === -1) closeIdx = 0;
  const question = prose.slice(0, closeIdx + 1).join(' ').trim();
  const guidance = prose.slice(closeIdx + 1).join(' ').trim() || null;

  return { question, guidance, choices };
}

/**
 * question_answer strategy: repeated blocks of
 *   <question> [guidance] [choices] <answerDelimiter> <answer>
 */
export function parseQuestionAnswer(text: string, config: ParseConfig): ParsedPair[] {
  const delimiter = config.answerDelimiter;
  if (!delimiter) return [];
  const bullet = config.choiceBullet ?? CHOICE_BULLET_DEFAULT;
  const unanswered = (config.unansweredMarkers ?? ['Unanswered']).map((m) => m.toLowerCase());

  const segments = text.split(delimiter);
  // Fewer than two segments means the delimiter never appeared: not this format.
  if (segments.length < 2) return [];

  const pairs: ParsedPair[] = [];
  // segments[0] is the preamble plus the FIRST question block; each later
  // segment opens with an answer and closes with the NEXT question block.
  let pendingQuestionBlock = segments[0]!;

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!;
    const { answer, rest } = takeAnswerLines(segment.split('\n'));

    const { question, guidance, choices } = splitQuestionBlock(pendingQuestionBlock, bullet);
    if (question) {
      const answerText = answer.join(' ').trim();
      pairs.push({
        order: pairs.length + 1,
        question,
        guidance,
        choices,
        answer:
          answerText === '' || unanswered.includes(answerText.toLowerCase())
            ? null
            : answerText,
      });
    }
    pendingQuestionBlock = rest.join('\n');
  }

  return pairs;
}

/**
 * question_marker strategy: a quote-portal export laid out as a two-column
 * Q/A table.
 *
 * Extraction leaves the column headers stranded on each row, so a question line
 * ends with a tab and 'Q', and each record closes with a lone 'A'. The answers
 * appear BEFORE their question, each stamped with a time and the adviser who
 * recorded it:
 *
 *     31/07/2026 13:34 - Heart attack, angina or stroke (A Adviser)
 *     31/07/2026 13:35 - Heart attack, angina or stroke, Diabetes (A Adviser)
 *     Have your birth parents, brothers, or sisters had any of these?→Q
 *     Options - Heart attack, angina or stroke, Cardiomyopathy, Diabetes, …
 *     A
 *
 * Two answers there is not a parse error, it is an amendment: the adviser
 * changed the answer a minute later. The last is current, the rest are kept as
 * revisions.
 */
/**
 * Rejoin an answer that wrapped across lines before parsing.
 *
 * A long option value pushes the trailing "(adviser name)" onto the next line:
 *
 *     31/07/2026 13:32 - I've never smoked, vaped, used e-cigarettes or other…
 *     (A Adviser)
 *
 * Left split, the line fails the answer pattern and the answer is silently
 * dropped — which cost the smoking answer on two of the three real documents.
 * Bounded to a few continuation lines so a malformed document cannot swallow the
 * rest of the file into one answer.
 */
function mergeWrappedAnswers(
  lines: string[],
  startRe: RegExp,
  attributionRe: RegExp,
  maxContinuationLines = 3
): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    // A complete answer closes with its "(adviser name)" attribution. One that
    // does not has wrapped. Testing the answer pattern itself is no good here:
    // the attribution group is optional, so a wrapped line matches it happily
    // and the wrap goes undetected.
    if (!startRe.test(trimmed) || attributionRe.test(trimmed)) {
      out.push(lines[i]!);
      continue;
    }
    let merged = trimmed;
    let consumed = 0;
    while (consumed < maxContinuationLines && i + 1 < lines.length) {
      const next = lines[i + 1]!.trim();
      // Never absorb another record's opening.
      if (next === '' || next === 'A' || startRe.test(next)) break;
      merged = `${merged} ${next}`;
      i++;
      consumed++;
      if (attributionRe.test(merged)) break;
    }
    out.push(merged);
  }
  return out;
}

export function parseQuestionMarker(text: string, config: ParseConfig): ParsedPair[] {
  const marker = config.questionMarker;
  if (!marker) return [];
  const answerRe = new RegExp(
    config.answerLinePattern ?? String.raw`^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}) - (.*?)(?: \(([^()]*)\))?$`
  );
  const optionsPrefix = config.optionsPrefix ?? 'Options - ';
  const answerStartRe = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} - /;
  const attributionRe = /\([^()]+\)\s*$/;
  const lines = mergeWrappedAnswers(
    text.split('\n').map((l) => l.replace(/\s+$/, '')),
    answerStartRe,
    attributionRe
  );

  // A question line ends with the stranded column header. Tolerate the tab
  // having been normalised to spaces by a different extractor build.
  const questionLineRe = new RegExp(String.raw`^(.*?)[\t ]+${escapeRegex(marker)}$`);

  const pairs: ParsedPair[] = [];
  for (let i = 0; i < lines.length; i++) {
    const qm = questionLineRe.exec(lines[i]!);
    if (!qm) continue;
    const question = (qm[1] ?? '').replace(/\s+/g, ' ').trim();
    if (question === '') continue;

    // Walk back over the answers belonging to this question, stopping at the
    // previous record's terminator or any other non-answer line.
    const answers: AnswerRevision[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const am = answerRe.exec(lines[j]!.trim());
      if (!am) break;
      answers.unshift({
        value: (am[2] ?? '').trim(),
        timestamp: am[1] ?? null,
        recordedBy: (am[3] ?? '').trim() || null,
      });
    }

    // Forward for guidance and choices, to the record terminator.
    const guidanceLines: string[] = [];
    let choices: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!.trim();
      if (line === 'A' || line === '') break;
      if (questionLineRe.test(lines[j]!)) break;
      if (line.startsWith(optionsPrefix)) {
        choices = line
          .slice(optionsPrefix.length)
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        continue;
      }
      guidanceLines.push(line);
    }

    const current = answers.length > 0 ? answers[answers.length - 1]! : null;
    pairs.push({
      order: pairs.length + 1,
      question,
      guidance: guidanceLines.join(' ').trim() || null,
      choices,
      answer: current?.value ?? null,
      answeredAt: current?.timestamp ?? null,
      recordedBy: current?.recordedBy ?? null,
      // Everything before the last is a superseded answer.
      revisions: answers.slice(0, -1),
    });
  }

  return pairs;
}

/**
 * label_value strategy: a flat summary sheet of "Label: value" pairs, as
 * returned for unit-based products. Carries no health questions, so it supports
 * identity and cover-selection checks only — the caller must not present a clean
 * result here as evidence that health answers matched.
 */
export function parseLabelValue(text: string, config: ParseConfig): ParsedPair[] {
  const labels = config.labels ?? [];
  if (labels.length === 0) return [];
  const unanswered = (config.unansweredMarkers ?? ['Unanswered']).map((m) => m.toLowerCase());

  // These sheets are laid out in two columns, and extraction interleaves them:
  // a label can be split across lines ("Marital \nstatus:"), its value can land
  // on the following line ("Email:\njimmy@…"), and two pairs can share one line
  // ("Employment status: Employed Occupation: Instructor"). Line structure is
  // therefore meaningless here — flatten it and let the labels themselves
  // delimit the values.
  const flat = text.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');

  const flexible = (s: string) => escapeRegex(s).replace(/\\?\s+/g, String.raw`\s+`);

  // A value ends at the next label (which must be followed by a colon) or at any
  // configured non-label terminator (which need not be). Longest first, so
  // "Employment status" wins over a bare "status" if both are configured.
  const labelTerms = [...labels].sort((a, b) => b.length - a.length).map(flexible);
  const extraTerms = [...(config.valueTerminators ?? [])]
    .sort((a, b) => b.length - a.length)
    .map(flexible);
  const stopParts = [`(?:${labelTerms.join('|')})\\s*:`];
  if (extraTerms.length > 0) stopParts.push(`(?:${extraTerms.join('|')})`);
  const stop = stopParts.join('|');
  const maxLength = config.maxValueLength ?? 120;

  const pairs: ParsedPair[] = [];
  for (const label of labels) {
    const re = new RegExp(
      flexible(label) + String.raw`\s*:\s*([\s\S]*?)(?=` + stop + String.raw`|$)`,
      'i'
    );
    const m = re.exec(flat);
    if (!m) continue;
    let value = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    // Backstop for the final label, which has nothing after it to stop at.
    if (value.length > maxLength) value = value.slice(0, maxLength).trimEnd();
    pairs.push({
      order: pairs.length + 1,
      question: label,
      guidance: null,
      choices: [],
      answer: value === '' || unanswered.includes(value.toLowerCase()) ? null : value,
    });
  }
  return pairs;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Hash of the ordered question wordings.
 *
 * Normalised so that cosmetic differences between two sales' documents — case,
 * whitespace, trailing punctuation, the customer's own data appearing inside a
 * label — do not read as the insurer having changed their question set. Only a
 * genuine change to the wording, order or membership of the question list moves
 * this hash.
 */
export function fingerprintQuestions(questions: string[]): string {
  const normalised = questions.map((q) =>
    q
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9 ]/g, '')
      .trim()
  );
  return createHash('sha256').update(normalised.join('\n')).digest('hex');
}

/**
 * Parse an application document with a known profile. Fully deterministic: the
 * cost of reading a document whose profile we hold is zero.
 */
export function parseApplication(
  rawText: string,
  strategy: ParseStrategy,
  config: ParseConfig
): ParsedApplication {
  // Isolate BEFORE stripping. Section markers are content headings, and a
  // per-line strip pattern aimed at a page footer ("Application form") matches
  // the section heading it is named after ("APPLICATION FORM") once patterns are
  // case-insensitive. Stripping first would delete the marker, isolation would
  // then find nothing, and the whole pack — quote, commission schedule and all —
  // would be parsed as if it were the application.
  const section = isolateSection(rawText, config);
  const cleaned = stripBoilerplate(section, config.stripPatterns);
  const pairs =
    strategy === 'question_answer'
      ? parseQuestionAnswer(cleaned, config)
      : strategy === 'question_marker'
        ? parseQuestionMarker(cleaned, config)
        : parseLabelValue(cleaned, config);

  return {
    strategy,
    pairs,
    fingerprint: fingerprintQuestions(pairs.map((p) => p.question)),
    empty: pairs.length === 0,
  };
}

/**
 * Flatten text so a detect pattern can be found in it regardless of how the PDF
 * happened to lay it out.
 *
 * A detect pattern is a sentence a human or a model read OFF the rendered page,
 * where it reads as one line. The extractor returns it as the PDF stores it,
 * broken wherever the column ran out:
 *
 *   "...upon which we will rely to produce your individual\nquotation."
 *
 * A raw substring test then fails on a sentence that is plainly, visibly there.
 * That is not a hypothetical: it threw away an otherwise correct profile learned
 * from a real application, and the same test decides at match time whether a
 * stored profile applies — so the two MUST normalise identically or a profile
 * could be accepted and then never match anything.
 *
 * Deliberately conservative: whitespace and the punctuation a PDF renders
 * typographically. Not hyphenation, where undoing a line-break hyphen risks
 * inventing a match that the page does not support.
 */
export function normaliseForDetection(text: string): string {
  return text
    .toLowerCase()
    // Curly quotes and dashes: the page renders them typographically, but
    // whoever typed the pattern almost certainly used the ASCII form.
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // \s covers the non-breaking and other Unicode spaces PDFs are full of.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Which stored profile describes this document? Content-based, never filename.
 * All of a profile's detect_patterns must appear for it to match, so a firm's
 * suitability report cannot satisfy an insurer application's profile by
 * coincidence.
 */
export function matchProfile<T extends { detect_patterns: string[] }>(
  rawText: string,
  profiles: T[]
): T | null {
  const haystack = normaliseForDetection(rawText);
  for (const profile of profiles) {
    const patterns = profile.detect_patterns ?? [];
    if (patterns.length === 0) continue;
    if (patterns.every((p) => haystack.includes(normaliseForDetection(p)))) return profile;
  }
  return null;
}

/**
 * Compare a freshly parsed question set against the profile it was parsed with.
 *
 * This is the cache-validity check and the drift detector in one. A mismatch
 * means the insurer changed something, and is the ONLY condition under which a
 * model pass runs to relearn the structure.
 */
export interface DriftReport {
  changed: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
}

export function detectDrift(
  storedQuestions: string[],
  parsedQuestions: string[]
): DriftReport {
  const norm = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
  const stored = storedQuestions.map(norm);
  const parsed = parsedQuestions.map(norm);
  const storedSet = new Set(stored);
  const parsedSet = new Set(parsed);

  const added = parsedQuestions.filter((q) => !storedSet.has(norm(q)));
  const removed = storedQuestions.filter((q) => !parsedSet.has(norm(q)));
  // Same membership, different order — worth flagging separately, because a
  // reordered set is usually a redesign rather than a content change.
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    stored.join('\n') !== parsed.join('\n');

  return {
    changed: added.length > 0 || removed.length > 0 || reordered,
    added,
    removed,
    reordered,
  };
}

/**
 * Filename signals used to ORDER download attempts. Deliberately not a filter:
 * the two real packs seen were named "Client review for <name>.pdf" and
 * "Application Details (5).pdf", so no positive pattern covers both and any
 * filename-based exclusion would eventually drop the real application. The
 * decision is always made on content by matchProfile; this only decides what to
 * download and inspect first, so the common case costs one fetch instead of four.
 */
const FILENAME_HINTS: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /application/i, score: 5 },
  // "app Mr Patrick Dixon.pdf" — the abbreviation an adviser types when
  // uploading by hand, and the observed naming on a real pack. Scored below the
  // full word so an explicit "Application ..." still wins a pack containing
  // both. Word-bounded, so it does not double-score "Application" itself, and
  // does not fire on "happy" or "appendix".
  { pattern: /\bapp\b/i, score: 4 },
  { pattern: /client review/i, score: 4 },
  { pattern: /details/i, score: 2 },
  // Documents that sit alongside the application and are NOT it. The suitability
  // report is the dangerous one: it is the firm's own advice record, mentions the
  // product, and contains customer and health detail, so it looks plausible.
  { pattern: /suitabilit/i, score: -5 },
  { pattern: /illustration/i, score: -4 },
  { pattern: /\bquote\b/i, score: -4 },
  { pattern: /commission/i, score: -4 },
  { pattern: /key ?facts|\bkfd\b/i, score: -3 },
  { pattern: /terms|policy booklet/i, score: -3 },
];

export interface RankedAttachment {
  file_name: string;
  created_time?: string | null;
}

/**
 * Order attachments by how likely each is to be the submitted application.
 * Non-PDFs are dropped — every insurer pack observed is a PDF. Ties break to the
 * most recent, so an amended re-upload is inspected before the copy it replaced.
 */
export function rankAttachmentCandidates<T extends RankedAttachment>(attachments: T[]): T[] {
  const score = (name: string) =>
    FILENAME_HINTS.reduce((total, h) => (h.pattern.test(name) ? total + h.score : total), 0);

  return attachments
    .filter((a) => /\.pdf$/i.test(a.file_name))
    .map((a, index) => ({ a, index, score: score(a.file_name) }))
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      const xt = x.a.created_time ?? '';
      const yt = y.a.created_time ?? '';
      if (xt !== yt) return yt.localeCompare(xt);
      // Stable: preserve the caller's order for genuine ties.
      return x.index - y.index;
    })
    .map((e) => e.a);
}

/**
 * Extract text from a PDF buffer. Kept as the single entry point so the
 * extractor can be swapped without touching any parsing logic.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  // pdf-parse v2 exports a PDFParse class, not v1's default callable. Instances
  // hold a worker, so destroy() must run even on failure or the process will not
  // exit.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

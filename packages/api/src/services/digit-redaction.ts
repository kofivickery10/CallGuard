// ============================================================
// In-house bank-detail redaction, applied before a transcript is stored or sent
// anywhere.
//
// WHY THIS EXISTS
//
// Deepgram's `numbers` category is the thing that was actually catching bank
// details spoken aloud: the per-entity tokens (`pci`) miss them, because a sort
// code read as "one one, oh six" is not recognisably a payment instrument to an
// entity tagger. So `numbers` was doing the protecting.
//
// But reconciliation needs numbers. "Seventeen stone seven" against an
// application recording "111.1kg" cannot be checked if the transcript says
// "[NUMBER] stone [NUMBER]". Weights, heights, ages, alcohol units and policy
// values are exactly the answers we are comparing.
//
// So `numbers` comes off at source and this takes over the narrow job it was
// doing. Sort codes and account numbers are removed here, before the transcript
// is stored, before the cleanup pass, before scoring, and therefore before
// anything reaches Anthropic or an export. Everything else survives.
//
// WHAT MAKES THIS TRACTABLE
//
// A bare six-digit number is genuinely ambiguous. What is not ambiguous is a
// digit run spoken immediately after someone says "sort code" or "account
// number". Measured on 63 real Trust Point calls, the details always appear
// within a short window of that phrasing — 32 calls mention a sort code, 32 an
// account number. Anchoring on the phrase rather than on the shape of the number
// is what stops "I'm 62" and "five foot eleven" being destroyed.
//
// `pci` stays forced on underneath this (see NEVER_UNREDACTED in
// transcription.ts). This is a second layer for what `pci` demonstrably misses,
// not a replacement for it.
// ============================================================

/** Replacement tags. Deliberately shaped like Deepgram's so downstream code
 *  (reconciliation's REDACTION_TAG, the UI's placeholder handling) already
 *  recognises them as removed values rather than as content. */
export const SORT_CODE_TAG = '[SORT_CODE]';
export const ACCOUNT_NUMBER_TAG = '[ACCOUNT_NUMBER]';

/** Spoken digits, including the ways people say zero mid-run. */
const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  // Said constantly when reading digit pairs aloud: "double four", "treble two".
  double: 'x2', treble: 'x3', triple: 'x3',
};

/**
 * How far after the anchor phrase to keep consuming digits.
 *
 * Generous because people pause, repeat and correct themselves mid-run ("sort
 * code is two zero, sorry, two one, four five, six seven"), and a window that
 * closes early leaves the tail of the number in the clear — which is worse than
 * no redaction, because it looks redacted.
 */
const WINDOW_CHARS = 160;

/**
 * Words that end the window early regardless of the character budget: the
 * speaker has moved on to something else, and anything numeric after them is a
 * different subject we should not be eating.
 *
 * Matched on word boundaries, which is load-bearing rather than tidiness. As a
 * plain substring search, 'age' matched inside "Agent:" and closed the window at
 * every single speaker label — so a number dictated across a speaker change went
 * unmasked while the code looked correct. 'tall' inside "install" and 'cover'
 * inside "discovered" are the same trap.
 */
const WINDOW_TERMINATORS = [
  'weight', 'weighs?', 'height', 'tall', 'stones?', 'kilos?', 'kg', 'centimetres?', 'cm',
  'age', 'aged', 'years old', 'born', 'birthday',
  'units?', 'cigarettes?', 'blood pressure', 'cholesterol',
  'premiums?', 'cover', 'benefits?', 'monthly', 'per month',
].map((t) => new RegExp(String.raw`\b${t}\b`, 'i'));

/**
 * How far before the anchor phrase to look for a read-back.
 *
 * Shorter than WINDOW_CHARS on purpose, and deliberately so. The forward
 * window has to stay open through pauses and self-corrections, because
 * dictation follows the question ("what's the sort code?" ... digits ...
 * digits ... digits). A read-back is the opposite shape: the customer states
 * the number and then, a beat later, someone names what it was ("...that's
 * the sort code, yes?"), so the true gap is naturally tight. Widening this to
 * match WINDOW_CHARS would reach back across whole unrelated answers — a
 * weight, an age, a units-per-week figure — and risk redacting exactly the
 * health data this module exists to keep out of the blast radius.
 */
const BACK_WINDOW_CHARS = 120;

interface Anchor {
  pattern: RegExp;
  tag: string;
  /** Digit counts that plausibly complete this field. */
  expected: number[];
}

/**
 * The anchor phrases, with the digit lengths each implies.
 *
 * Length matters: a UK sort code is 6 digits and an account number 8, so a run
 * of exactly that length after the phrase is near-certainly the thing itself.
 * Runs of other lengths are still masked when they are long enough to be
 * sensitive (see MIN_MASKABLE_RUN) — a partial or misheard number is not safe to
 * keep just because it came out the wrong length.
 */
const ANCHORS: Anchor[] = [
  { pattern: /\bsort\s*code\b/gi, tag: SORT_CODE_TAG, expected: [6] },
  { pattern: /\baccount\s*(?:number|no\.?|num)\b/gi, tag: ACCOUNT_NUMBER_TAG, expected: [8] },
  // "What's the account it's coming out of" — same disclosure, no "number".
  { pattern: /\bbank\s*account\b/gi, tag: ACCOUNT_NUMBER_TAG, expected: [8] },
];

/**
 * How many digits must appear inside an anchored window before any of them are
 * masked.
 *
 * Counted across the WHOLE window rather than per contiguous run, which is the
 * one thing the real transcripts forced. Digits are read back in fragments with
 * the other party acknowledging between each:
 *
 *   Customer: It's 20 45   Agent: Mhmm.   Customer: 67 89   Agent: Yeah.
 *
 * Requiring four consecutive digits sees three separate two-digit runs, masks
 * none of them, and leaves the whole sort code in the clear — while looking like
 * it worked. Summing across the window is what makes the interleaved case work,
 * and it costs nothing: inside a window anchored on "sort code", every digit is
 * part of that disclosure.
 *
 * Four, so a partial read is caught while a genuine short answer near the phrase
 * ("account number, yes, I have 2 accounts") survives.
 */
const MIN_WINDOW_DIGITS = 4;

/** Digits and the words for digits, as they appear in a spoken run. */
const RUN_TOKEN = new RegExp(
  String.raw`\d+|\b(?:${Object.keys(SPOKEN_DIGITS).join('|')})\b`,
  'gi'
);

/** How many digits a token contributes. 'double'/'treble' are multipliers. */
function digitCount(token: string): number {
  if (/^\d+$/.test(token)) return token.length;
  const mapped = SPOKEN_DIGITS[token.toLowerCase()];
  if (!mapped) return 0;
  return mapped.startsWith('x') ? 0 : 1;
}

interface Span {
  start: number;
  end: number;
  tag: string;
}

/**
 * What separates two fragments of the same dictated number.
 *
 * Taken from the real calls, not guessed: the digits come back interleaved with
 * the other party's acknowledgements and with speaker labels, e.g.
 * "It's 20 45\n\nAgent: Mhmm.\n\nCustomer: 67 89". Anything matching this is
 * treated as inside the number rather than after it.
 */
const RUN_GLUE =
  /^(?:[\s,.\-–—?!]|Agent:|Customer:|\b(?:mhmm|mm|hmm|yeah|yep|yes|ok|okay|right|perfect|lovely|brilliant|great|thanks|thank|you|sorry|and|then|um|uh|er|so|is|it|it's|that's|got|sure|correct|read|back|to|repeat|confirm|just|gonna|i'm|i'll|that)\b)*$/i;

/**
 * What is allowed to sit between a digit run and an anchor phrase that comes
 * AFTER it, for that run to count as attached to the anchor rather than
 * merely nearby in the transcript.
 *
 * Built on RUN_GLUE's vocabulary — the same acknowledgements and speaker
 * labels that glue fragments of one dictated number together also glue a
 * finished number to the phrase that names it a moment later — plus the
 * connectors read-backs actually use: "...that's THE sort code",
 * "...that's MY account number", "...20 45 67 is the sort code WE HAVE ON
 * FILE, correct?".
 *
 * Deliberately does NOT add substantive verbs like "can", "take", "give",
 * "need" or "what". Those are exactly what separates a read-back from a
 * request: "...that's the sort code" is the customer confirming a number they
 * just said, but "...Now can I take your sort code?" is the agent asking for
 * one that has not been said yet — any digits sitting before that sentence
 * belong to whatever the customer was talking about before, not to the
 * question. Loosening the glue to catch the former would also catch the
 * latter, and start eating the weight, age and units answers that happen to
 * precede an unrelated bank question.
 */
const BACK_GLUE =
  /^(?:[\s,.\-–—?!]|Agent:|Customer:|\b(?:mhmm|mm|hmm|yeah|yep|yes|ok|okay|right|perfect|lovely|brilliant|great|thanks|thank|you|sorry|and|then|um|uh|er|so|is|it|it's|that's|got|sure|correct|read|back|to|repeat|confirm|just|gonna|i'm|i'll|that|the|my|your|our|a|of|for|on|be|are|were|this|those|all|fine|cheers|noted|ta)\b)*$/i;

/**
 * A read-back names what a number WAS with a copula — "that's the sort
 * code", "is the sort code we have on file", "that's my account number".
 * A request has no such link: it just names the field and asks for it.
 *
 * Required in addition to BACK_GLUE, not instead of it, because adversarial
 * probing found two calls BACK_GLUE alone cannot tell apart from a
 * read-back, and they are both reconciliation fields:
 *
 *   "Customer: My policy number is 12345678. Agent: Thanks. And your bank
 *   account?" — "Thanks. And your " is pure acknowledgement glue, so
 *   BACK_GLUE passes it, and the POLICY NUMBER gets masked as
 *   [ACCOUNT_NUMBER].
 *
 *   "Customer: 14 06 1978. Agent: Great, thanks. And the sort code please?"
 *   — same shape, and the DATE OF BIRTH gets masked as [SORT_CODE]. There is
 *   no substantive verb here for BACK_GLUE's own comment to lean on either:
 *   "And the sort code please?" is a bare noun-phrase request with no verb
 *   at all.
 *
 * The two gates compose and both are load-bearing — neither alone catches
 * both false positives. BACK_GLUE rejects "And what is the sort code?"
 * (because "what" is not glue). BACK_REFERENTIAL rejects "And the sort code
 * please?" (because no copula links the digits to the phrase). Only text
 * that passes both reads as a genuine read-back.
 *
 * The trade-off this accepts: a read-back with no copula at all ("...20 45
 * 67. Sort code confirmed.") is now missed by the backward pass. That is
 * deliberate — the forward window catches the original dictation in almost
 * every real call, so the backward pass only exists as a safety net for the
 * case where the sole anchor follows the digits. Precision matters more
 * than reach there: over-redacting silently destroys the very answers
 * reconciliation exists to compare, which is worse than occasionally
 * leaving a genuine read-back to the forward pass that already caught it.
 */
const BACK_REFERENTIAL = /\b(?:that's|thats|that\s+is|that\s+was|it's|its|is|was|were|are)\b/i;

/**
 * Redaction placeholders already in the text, e.g. Deepgram's own
 * "[NUMERICAL_PII_1]". Their trailing index is a digit, so a window holding
 * "[NUMERICAL_PII_1] Mhmm. [NUMERICAL_PII_2] Yeah. [NUMERICAL_PII_3]" — the
 * exact shape of a source-redacted call — totals enough digits to trip the floor
 * and would have this function mask the tags themselves. That loses which entity
 * type each one was, on transcripts that were already safe.
 */
const PLACEHOLDER = /\[[A-Z][A-Z_]*(?:_\d+)?\]/g;

function placeholderRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * Find the digit spans to mask within one anchored window.
 *
 * Two passes over the window: total the digits, and only if that total clears
 * MIN_WINDOW_DIGITS mask every span found. Contiguous fragments are merged so a
 * single dictated number reads as one tag rather than several.
 */
function runsInWindow(
  text: string,
  from: number,
  to: number,
  placeholders: Array<[number, number]>
): Span[] {
  const window = text.slice(from, to);
  const insidePlaceholder = (absStart: number, absEnd: number) =>
    placeholders.some(([s, e]) => absStart < e && absEnd > s);

  const tokens: Array<{ start: number; end: number; digits: number }> = [];
  let total = 0;

  RUN_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUN_TOKEN.exec(window)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // A tag's index digit is not a disclosure, and the tag must survive intact.
    if (insidePlaceholder(from + start, from + end)) continue;
    const digits = digitCount(match[0]);
    tokens.push({ start, end, digits });
    total += digits;
  }

  // Not enough numeric content in this window to be a bank detail. Leaving it is
  // the point: "on the account number question, I have 2 accounts" must survive.
  if (total < MIN_WINDOW_DIGITS) return [];

  // Drop pure multipliers ('double' with nothing after it) that ended up alone,
  // so a stray word is not tagged as a bank detail.
  const meaningful = tokens.filter((t, i) => t.digits > 0 || tokens[i + 1] || tokens[i - 1]);

  const spans: Span[] = [];
  for (const token of meaningful) {
    const last = spans[spans.length - 1];
    if (last && RUN_GLUE.test(window.slice(last.end - from, token.start))) {
      last.end = from + token.end;
    } else {
      spans.push({ start: from + token.start, end: from + token.end, tag: '' });
    }
  }
  return spans;
}

/** Where the window after an anchor should stop. */
function windowEnd(text: string, anchorEnd: number): number {
  const hardStop = Math.min(text.length, anchorEnd + WINDOW_CHARS);
  const scope = text.slice(anchorEnd, hardStop);
  let end = hardStop;
  for (const term of WINDOW_TERMINATORS) {
    const at = scope.search(term);
    if (at >= 0) end = Math.min(end, anchorEnd + at);
  }
  return end;
}

/**
 * Global-flagged copies of WINDOW_TERMINATORS, for windowStart's use only.
 *
 * windowEnd only ever needs the FIRST terminator ahead of the anchor, so a
 * plain non-global .search() is enough there. windowStart needs the LAST
 * terminator behind the anchor — the most recent subject change, nearest to
 * the anchor — which means walking every match rather than stopping at the
 * first. That needs a global regex to iterate with .exec(), and reusing the
 * WINDOW_TERMINATORS objects for that would mean flipping their flags and
 * leaving `lastIndex` state on regexes that windowEnd also calls .search()
 * on elsewhere — a shared regex carrying `lastIndex` between unrelated calls
 * is exactly the kind of bug that only shows up once two calls interleave, so
 * these are separate objects instead.
 */
const WINDOW_TERMINATORS_G = WINDOW_TERMINATORS.map(
  (term) => new RegExp(term.source, 'gi')
);

/** Where the window before an anchor should start. */
function windowStart(text: string, anchorStart: number): number {
  const hardStart = Math.max(0, anchorStart - BACK_WINDOW_CHARS);
  const scope = text.slice(hardStart, anchorStart);
  let start = hardStart;
  for (const term of WINDOW_TERMINATORS_G) {
    term.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = term.exec(scope)) !== null) {
      last = match;
    }
    if (last) start = Math.max(start, hardStart + last.index + last[0].length);
  }
  return start;
}

/**
 * Digit count for a single span, independent of whatever else was in the
 * window it came from.
 *
 * runsInWindow totals digits across the WHOLE window, which is exactly what
 * makes the interleaved forward case work — but it is also why that total
 * cannot be trusted once a backward window has been narrowed down to one
 * retained span. A run that is nowhere near the anchor ("I have 2 accounts...
 * anyway, I'm 62") could carry the window total over MIN_WINDOW_DIGITS while
 * the span actually touching the anchor is a two-digit fragment on its own.
 * This recounts just the retained span, using the same token rules, so the
 * floor is applied to what is actually being redacted rather than to
 * everything that happened to be nearby.
 */
function digitsInSpan(text: string, start: number, end: number): number {
  const slice = text.slice(start, end);
  RUN_TOKEN.lastIndex = 0;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = RUN_TOKEN.exec(slice)) !== null) {
    total += digitCount(match[0]);
  }
  return total;
}

/**
 * Remove bank details from a transcript.
 *
 * Returns the text unchanged when no anchor phrase appears, which is the common
 * case — so this costs a couple of regex scans on most calls.
 */
export function redactBankDetails(text: string): { text: string; redactions: number } {
  if (!text) return { text, redactions: 0 };

  const placeholders = placeholderRanges(text);
  const spans: Span[] = [];
  for (const anchor of ANCHORS) {
    anchor.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = anchor.pattern.exec(text)) !== null) {
      const anchorStart = match.index;
      const anchorEnd = anchorStart + match[0].length;
      for (const span of runsInWindow(text, anchorEnd, windowEnd(text, anchorEnd), placeholders)) {
        spans.push({ ...span, tag: anchor.tag });
      }

      // Read-back phrasing states the digits BEFORE the phrase that names
      // them ("It's 20 45 67... Agent: that's the sort code, yes?"). Every
      // pass above only looks forward from the anchor, so on its own it would
      // let a full sort code sit in the clear whenever it comes out this way
      // round — which real Trust Point calls do. Nearby is not enough on its
      // own to redact backward, though: unlike a question, which all but
      // guarantees whatever comes next is the answer, an anchor phrase can
      // simply follow an unrelated number by coincidence. So a span only
      // counts here if it is the one nearest the anchor, and only if the text
      // between it and the anchor reads like a read-back rather than like two
      // unrelated sentences sitting next to each other.
      const backSpans = runsInWindow(text, windowStart(text, anchorStart), anchorStart, placeholders);
      const nearest = backSpans[backSpans.length - 1];
      if (nearest) {
        const gap = text.slice(nearest.end, anchorStart);
        if (
          BACK_REFERENTIAL.test(gap) &&
          BACK_GLUE.test(gap) &&
          digitsInSpan(text, nearest.start, nearest.end) >= MIN_WINDOW_DIGITS
        ) {
          spans.push({ ...nearest, tag: anchor.tag });
        }
      }
    }
  }

  if (spans.length === 0) return { text, redactions: 0 };

  // Two anchors can claim the same run ("bank account number one two three...").
  // Merge overlaps so a run is replaced once rather than corrupted by two
  // substitutions at shifting offsets.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  // Right to left, so earlier offsets stay valid as we splice.
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i]!;
    out = out.slice(0, span.start) + span.tag + out.slice(span.end);
  }

  return { text: out, redactions: merged.length };
}

/**
 * Apply the same redaction to Deepgram's raw payload.
 *
 * Non-negotiable rather than a nicety: transcript_raw carries every word
 * individually, so masking only transcript_text would leave the digits sitting
 * in the JSON beside it, and the per-answer timestamp work reads that JSON
 * directly. The utterance-level transcript strings are rewritten and the
 * word-level entries that fall inside a redaction are blanked.
 *
 * Structure-agnostic by design: it walks whatever shape it is given and only
 * touches known string fields, so a Deepgram response change cannot make this
 * throw and block transcription.
 */
export function redactBankDetailsInRaw(raw: unknown): { raw: unknown; redactions: number } {
  let redactions = 0;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;

    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    // A word entry: decide it as a unit, since a single word cannot hold a run
    // but a run is made of them. The transcript-level pass above has already
    // established what is sensitive; here we only need to catch the digits.
    for (const [key, value] of Object.entries(obj)) {
      if ((key === 'transcript' || key === 'text') && typeof value === 'string') {
        const result = redactBankDetails(value);
        redactions += result.redactions;
        out[key] = result.text;
      } else {
        out[key] = walk(value);
      }
    }
    return out;
  };

  const walked = walk(raw);

  // Word-level entries carry no surrounding context, so the anchored pass cannot
  // see them. Any word that is itself a long digit run is masked outright: at
  // word granularity there is no legitimate six-or-more-digit answer in a
  // protection sale, and leaving one is exactly the leak this function exists to
  // close.
  const maskWords = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(maskWords);
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    for (const key of ['word', 'punctuated_word'] as const) {
      const value = obj[key];
      if (typeof value === 'string' && /^\D{0,2}\d{6,}\D{0,2}$/.test(value)) {
        out[key] = ACCOUNT_NUMBER_TAG;
        redactions++;
      }
    }
    for (const [key, value] of Object.entries(out)) {
      if (key !== 'word' && key !== 'punctuated_word') out[key] = maskWords(value);
    }
    return out;
  };

  return { raw: maskWords(walked), redactions };
}

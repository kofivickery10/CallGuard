// Pin a checkpoint's evidence quote to a place in the call: the transcript
// block it was said in, and the second of the recording it starts at.
//
// A reviewer resolving a manual-review checkpoint (routes/review.ts) has to be
// able to check the AI's quote against what was actually said — reading the
// words around it and, where a recording exists, hearing it. Neither is stored:
// score rows carry the quote and (for journeys) the source call, but
// journey_item_scores.source_timestamp is never populated by the scorer, so the
// position has to be recovered from the transcript itself.
//
// Two matching surfaces, both fuzzy on purpose:
//  - `calls.transcript_text` — the CLEANED transcript (services/transcript-
//    cleanup.ts rewrote mishearings after Deepgram), and what the scorer read,
//    so the quote should be close to verbatim here.
//  - `calls.transcript_raw.results.utterances[]` — the ORIGINAL Deepgram
//    utterances, the only thing carrying timestamps. Their wording predates the
//    cleanup pass, so an exact match is not available and token overlap is.

export interface TranscriptBlock {
  index: number;
  speaker: 'Agent' | 'Customer' | null;
  text: string;
}

export interface RawUtterance {
  start: number;
  text: string;
}

export interface ExcerptLine extends TranscriptBlock {
  is_match: boolean;
}

export interface EvidenceLocationResult {
  timestamp_seconds: number | null;
  matched: boolean;
  excerpt: ExcerptLine[];
}

// Below this share of the quote's word-pairs appearing in a candidate line, the
// "match" is coincidental word overlap rather than the same sentence. Set by
// hand against real evidence quotes: cleanup rewrites and the scorer's habit of
// trimming a quote mid-sentence cost real overlap, so the floor has to sit well
// under 1.0, but two unrelated lines of the same call rarely share a third of
// their word-pairs.
export const MATCH_FLOOR = 0.34;

// How many blocks either side of the match to return, so the reviewer reads the
// quote in its conversational context rather than in isolation.
const CONTEXT_BLOCKS = 2;

/** Split a stored transcript into its `Speaker: text` blocks. */
export function parseTranscriptBlocks(transcript: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const line of transcript.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const speaker = trimmed.startsWith('Agent:')
      ? 'Agent'
      : trimmed.startsWith('Customer:')
        ? 'Customer'
        : null;
    const text = speaker ? trimmed.slice(speaker.length + 1).trim() : trimmed;
    blocks.push({ index: blocks.length, speaker, text });
  }
  return blocks;
}

/**
 * Strip what the scorer wraps a quote in so only the spoken words are matched:
 * the `[Call 2]` marker a journey transcript carries (services/journey-
 * transcript.ts), a `Agent:` / `Customer:` prefix, and surrounding quote marks.
 */
export function stripQuoteDecoration(quote: string): string {
  let out = quote.trim();
  out = out.replace(/^\[\s*call\s+\d+[^\]]*\]\s*/i, '');
  out = out.replace(/^-?\s*call\s+\d+\s*:\s*/i, '');
  out = out.replace(/^(agent|customer|adviser)\s*:\s*/i, '');
  out = out.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '');
  return out.trim();
}

// Shorter than this (in words) a fragment is a stock phrase — "is that okay",
// "yep that's fine" — that occurs all over a sales call, so matching on it would
// cue the reviewer to an arbitrary occurrence.
const MIN_FRAGMENT_WORDS = 5;

/**
 * The passages worth looking for in a checkpoint's `evidence`.
 *
 * Real evidence is not one verbatim quote: the scorer writes a short narrative
 * that strings several quoted fragments together, sometimes across calls
 * ("...we'll never pass your details on... Okay?" Agent: "Right, sure." - Call
 * 5: "Is that okay?"), and sometimes states that a phrasing was NOT found —
 * quoting the wording it looked for. So each quoted span is a candidate in its
 * own right, plus the whole string for the common single-quote case, and the
 * best-scoring one wins. A candidate that merely echoes the scorecard's expected
 * wording won't clear MATCH_FLOOR against anything actually said.
 */
export function candidateFragments(evidence: string): string[] {
  const cleaned = evidence
    .replace(/\[\s*call\s+\d+[^\]]*\]/gi, ' ')
    .replace(/-?\s*call\s+\d+\s*:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const candidates: string[] = [];
  for (const pattern of [/"([^"]+)"/g, /“([^”]+)”/g]) {
    for (const match of cleaned.matchAll(pattern)) candidates.push(match[1]);
  }
  candidates.push(cleaned);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const fragment = stripQuoteDecoration(candidate);
    if (tokenise(fragment).length < MIN_FRAGMENT_WORDS) continue;
    const key = normalise(fragment);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fragment);
  }
  return out;
}

// Lowercase, drop punctuation, collapse whitespace. Redaction tags
// ([NAME_GIVEN_1]) survive as words, which is what we want — they appear
// identically in both transcripts and are strong anchors.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\[\]_\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenise(text: string): string[] {
  const n = normalise(text);
  return n ? n.split(' ') : [];
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * How much of `needle` appears in `haystack`, 0–1. Substring containment scores
 * 1; otherwise it is the share of the needle's word-pairs present in the
 * haystack, which tolerates the cleanup pass having reworded the odd word
 * without rewarding two lines that merely share common words.
 */
export function matchScore(haystack: string, needle: string): number {
  const h = normalise(haystack);
  const n = normalise(needle);
  if (!h || !n) return 0;
  if (h.includes(n)) return 1;

  const needleTokens = n.split(' ');
  // Too short for word-pairs — containment was the only honest test, and it
  // failed. Scoring a 1–2 word quote on token overlap matches everywhere.
  if (needleTokens.length < 3) return 0;

  const pairs = bigrams(needleTokens);
  const hay = ` ${h} `;
  let hits = 0;
  for (const pair of pairs) if (hay.includes(` ${pair} `)) hits++;
  return hits / pairs.length;
}

/** The best-matching entry for `quote`, or null when nothing clears the floor. */
export function locateQuote<T extends { text: string }>(
  items: T[],
  quote: string,
  floor: number = MATCH_FLOOR
): { index: number; score: number } | null {
  const needle = stripQuoteDecoration(quote);
  if (!needle) return null;

  let best: { index: number; score: number } | null = null;
  items.forEach((item, index) => {
    const score = matchScore(item.text, needle);
    if (score >= floor && (!best || score > best.score)) best = { index, score };
  });
  return best;
}

/** The timestamped utterances out of a stored Deepgram response, in time order. */
export function extractUtterances(raw: unknown): RawUtterance[] {
  const utterances = (raw as { results?: { utterances?: unknown[] } } | null)?.results?.utterances;
  if (!Array.isArray(utterances)) return [];
  const out: RawUtterance[] = [];
  for (const u of utterances) {
    const utt = u as { transcript?: unknown; start?: unknown };
    if (typeof utt.transcript !== 'string' || !utt.transcript.trim()) continue;
    const start = Number(utt.start);
    out.push({ start: Number.isFinite(start) ? start : 0, text: utt.transcript });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Locate an evidence quote in a call: the transcript excerpt around it and the
 * second of audio it starts at. A quote that can't be pinned returns
 * `matched: false` with an empty excerpt — the caller should send the reviewer
 * to the full transcript rather than to a guessed position.
 */
export function locateEvidence(params: {
  quote: string | null;
  transcriptText: string | null;
  transcriptRaw?: unknown;
}): EvidenceLocationResult {
  const { quote, transcriptText, transcriptRaw } = params;
  if (!quote || !quote.trim() || !transcriptText) {
    return { timestamp_seconds: null, matched: false, excerpt: [] };
  }

  const blocks = parseTranscriptBlocks(transcriptText);

  // Best (fragment, block) pair across every candidate passage.
  let hit: { index: number; score: number; fragment: string } | null = null;
  for (const fragment of candidateFragments(quote)) {
    const found = locateQuote(blocks, fragment);
    if (found && (!hit || found.score > hit.score)) hit = { ...found, fragment };
  }

  // No idea where the passage is in the transcript, so we have no business
  // claiming to know where it is in the audio either: a stock phrase's opening
  // words occur all over a sales call, and cueing playback to the wrong one
  // reads as evidence. Leave the reviewer at the start of the recording.
  if (!hit) return { timestamp_seconds: null, matched: false, excerpt: [] };

  // Deepgram splits speech into short utterances while the stored transcript
  // merges consecutive ones per speaker, so a matched block covers several
  // utterances. Playback must start where the passage starts, so the
  // opening-words anchor is tried FIRST — the best fuzzy match across utterances
  // can be a later part of the same passage (whichever survived the cleanup pass
  // most intact), which would drop the reviewer in mid-sentence.
  const utterances = extractUtterances(transcriptRaw);
  const anchor = firstUtteranceWithOpeningWords(utterances, hit.fragment);
  const uttHit =
    anchor === null && utterances.length > 0 ? locateQuote(utterances, hit.fragment) : null;
  const timestamp = anchor ?? (uttHit !== null ? utterances[uttHit.index].start : null);

  const from = Math.max(0, hit.index - CONTEXT_BLOCKS);
  const to = Math.min(blocks.length - 1, hit.index + CONTEXT_BLOCKS);
  const excerpt: ExcerptLine[] = [];
  for (let i = from; i <= to; i++) excerpt.push({ ...blocks[i], is_match: i === hit.index });

  return { timestamp_seconds: timestamp, matched: true, excerpt };
}

// The opening of a quote is the part least likely to have been trimmed by the
// scorer, so a 4-word run from it is the most reliable anchor into the
// untouched (timestamped) utterances.
function firstUtteranceWithOpeningWords(
  utterances: RawUtterance[],
  quote: string
): number | null {
  const tokens = tokenise(stripQuoteDecoration(quote));
  if (tokens.length < 4) return null;
  const opening = tokens.slice(0, 4).join(' ');
  for (const u of utterances) {
    if (normalise(u.text).includes(opening)) return u.start;
  }
  return null;
}

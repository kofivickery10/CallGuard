// The multi-call evidence-attribution contract, in ONE place.
//
// Journey scoring and journey data-capture both (a) build a combined
// transcript whose calls are delimited by "=== Call N (...) ===" headers,
// (b) prompt Claude to prefix evidence quotes with the matching "[Call N]"
// marker, and (c) parse that marker back to attribute evidence to its source
// call. The header numbering and the marker parser must stay in lockstep —
// a divergence between two copies would silently mis-attribute evidence while
// still "parsing" cleanly, so both live here and nowhere else.

export interface TranscriptCallInput {
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  transcript_text: string | null;
}

// Matches the "[Call N] ..." prefix Claude is asked to put on journey
// evidence quotes. N is 1-based over the calls passed to
// buildCombinedTranscript, in the same order.
export const CALL_MARKER = /^\[Call (\d+)\]\s*/;

/**
 * One call-delimited transcript for a whole journey, so a single Claude call
 * sees every conversation at once (a consent given in call 1 and a sale closed
 * in call 3 are evaluated together). Callers must pass calls already filtered
 * to those WITH a transcript, ordered oldest-first — the 1-based header number
 * is what the CALL_MARKER parser resolves back to an index.
 */
export function buildCombinedTranscript(calls: TranscriptCallInput[]): string {
  return buildCombinedTranscriptWithOffsets(calls).text;
}

/** Where one call's block sits within the combined transcript. */
export interface CombinedSegment {
  /** 0-based index into the calls array passed in. */
  index: number;
  /** 1-based, matching the "=== Call N ===" header and the [Call N] marker. */
  callNumber: number;
  /** Character offset of the block's first character in the combined text. */
  start: number;
  /** Character offset one past the block's last character. */
  end: number;
}

const BLOCK_SEPARATOR = '\n\n';

/**
 * The combined transcript plus each call's character range within it.
 *
 * Needed because reconciliation locates evidence by searching the combined text
 * directly rather than asking a model to emit a [Call N] marker. Both routes must
 * resolve to the same call number, so the block format and its offsets are
 * produced together here — a second implementation of the layout would
 * mis-attribute evidence while still looking correct.
 */
export function buildCombinedTranscriptWithOffsets(
  calls: TranscriptCallInput[]
): { text: string; segments: CombinedSegment[] } {
  const blocks = calls.map((c, i) => {
    const date = c.call_date ?? c.created_at;
    return `=== Call ${i + 1} (${new Date(date).toLocaleDateString('en-GB')}, agent: ${c.agent_name ?? 'unknown'}) ===\n${c.transcript_text}`;
  });

  const segments: CombinedSegment[] = [];
  let position = 0;
  blocks.forEach((block, i) => {
    segments.push({ index: i, callNumber: i + 1, start: position, end: position + block.length });
    position += block.length + BLOCK_SEPARATOR.length;
  });

  return { text: blocks.join(BLOCK_SEPARATOR), segments };
}

/**
 * Which call a character offset falls in, or null if it lands in the separator
 * between two blocks or outside the text entirely. Returning null rather than
 * guessing the nearest call keeps a mis-attributed quote impossible.
 */
export function callNumberAtOffset(segments: CombinedSegment[], offset: number): number | null {
  for (const s of segments) {
    if (offset >= s.start && offset < s.end) return s.callNumber;
  }
  return null;
}

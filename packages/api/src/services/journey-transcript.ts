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
  return calls
    .map((c, i) => {
      const date = c.call_date ?? c.created_at;
      return `=== Call ${i + 1} (${new Date(date).toLocaleDateString('en-GB')}, agent: ${c.agent_name ?? 'unknown'}) ===\n${c.transcript_text}`;
    })
    .join('\n\n');
}

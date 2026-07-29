import { describe, it, expect } from 'vitest';
import {
  candidateFragments,
  extractUtterances,
  locateEvidence,
  locateQuote,
  matchScore,
  parseTranscriptBlocks,
  stripQuoteDecoration,
  MATCH_FLOOR,
} from './evidence-locator.js';

// A cleaned transcript as stored on calls.transcript_text.
const TRANSCRIPT = `Agent: Morning, it's Heena calling from Trust Point. Just so you know, this call is recorded.

Customer: That's fine.

Agent: Before I go through the cover, are you happy for me to share your details with the insurer?

Customer: Yes, that's no problem at all.

Agent: Lovely. So the premium comes to twenty four pounds a month, and I'll email the documents over today.

Customer: Yes, email is fine.`;

// The same call as Deepgram returned it, before the cleanup pass: shorter
// utterances, the odd mishearing ("Trustpoint"), and the only timestamps we have.
const RAW = {
  results: {
    utterances: [
      { start: 0.5, transcript: "Morning, it's Heena calling from Trustpoint.", speaker: 0 },
      { start: 3.2, transcript: 'Just so you know, this call is recorded.', speaker: 0 },
      { start: 6.0, transcript: "That's fine.", speaker: 1 },
      { start: 7.4, transcript: 'Before I go through the cover,', speaker: 0 },
      { start: 9.1, transcript: 'are you happy for me to share your details with the insurer?', speaker: 0 },
      { start: 13.8, transcript: "Yes, that's no problem at all.", speaker: 1 },
      { start: 16.2, transcript: 'Lovely. So the premium comes to 24 pounds a month,', speaker: 0 },
      { start: 20.0, transcript: "and I'll email the documents over today.", speaker: 0 },
      { start: 23.1, transcript: 'Yes, email is fine.', speaker: 1 },
    ],
  },
};

describe('parseTranscriptBlocks', () => {
  it('splits into speaker-tagged blocks and drops blank lines', () => {
    const blocks = parseTranscriptBlocks(TRANSCRIPT);
    expect(blocks).toHaveLength(6);
    expect(blocks[0].speaker).toBe('Agent');
    expect(blocks[1]).toEqual({ index: 1, speaker: 'Customer', text: "That's fine." });
  });

  it('keeps an unlabelled line as a block with no speaker', () => {
    const blocks = parseTranscriptBlocks('no speaker prefix here');
    expect(blocks).toEqual([{ index: 0, speaker: null, text: 'no speaker prefix here' }]);
  });
});

describe('stripQuoteDecoration', () => {
  it('strips the journey transcript\'s call marker, speaker prefix and quote marks', () => {
    expect(stripQuoteDecoration('[Call 2] Customer: "Yes, that\'s no problem at all."')).toBe(
      "Yes, that's no problem at all."
    );
  });

  it('leaves a bare quote alone', () => {
    expect(stripQuoteDecoration('  Yes, email is fine.  ')).toBe('Yes, email is fine.');
  });
});

describe('candidateFragments', () => {
  it('pulls out each quoted passage of a multi-fragment narrative', () => {
    // The shape real journey evidence takes: several quotes strung together,
    // with a call marker mid-string.
    const fragments = candidateFragments(
      '"Before I go through the cover, are you happy for me to share your details with the insurer?" ' +
        'Customer: "Yes, that\'s no problem at all." - Call 5: "Is that okay?"'
    );
    expect(fragments).toContain(
      'Before I go through the cover, are you happy for me to share your details with the insurer?'
    );
    expect(fragments).toContain("Yes, that's no problem at all.");
    // "Is that okay?" is a stock phrase — too short to locate anything by.
    expect(fragments.some((f) => f === 'Is that okay?')).toBe(false);
  });

  it('keeps a plain single quote as the only candidate', () => {
    expect(candidateFragments('Yes, that is no problem at all.')).toEqual([
      'Yes, that is no problem at all.',
    ]);
  });

  it('has no candidate in a quote-free note too short to locate', () => {
    expect(candidateFragments('Not found.')).toEqual([]);
  });
});

describe('matchScore', () => {
  it('scores a verbatim quote 1', () => {
    expect(matchScore("Yes, that's no problem at all.", "yes that's no problem at all")).toBe(1);
  });

  it('scores a reworded quote on word-pair overlap', () => {
    const score = matchScore(
      "Morning, it's Heena calling from Trustpoint.",
      "Morning, it's Heena calling from Trust Point."
    );
    expect(score).toBeGreaterThanOrEqual(MATCH_FLOOR);
    expect(score).toBeLessThan(1);
  });

  it('does not match an unrelated line of the same call', () => {
    expect(
      matchScore(
        'Lovely. So the premium comes to twenty four pounds a month.',
        'are you happy for me to share your details with the insurer?'
      )
    ).toBeLessThan(MATCH_FLOOR);
  });

  it('refuses to match a one or two word quote on overlap alone', () => {
    // "fine" appears in the line, but a two-word quote scored on overlap would
    // match half the call — containment is the only honest test and it failed.
    expect(matchScore("Yes, email is fine.", 'is fine')).toBe(1);
    expect(matchScore("Yes, email is fine.", 'no problem')).toBe(0);
  });
});

describe('locateQuote', () => {
  it('finds the block a quote was said in', () => {
    const blocks = parseTranscriptBlocks(TRANSCRIPT);
    const hit = locateQuote(blocks, 'are you happy for me to share your details with the insurer?');
    expect(hit?.index).toBe(2);
  });

  it('returns null when the quote is not in the transcript', () => {
    const blocks = parseTranscriptBlocks(TRANSCRIPT);
    expect(locateQuote(blocks, 'I confirm you have a fourteen day cooling off period')).toBeNull();
  });
});

describe('extractUtterances', () => {
  it('reads the timestamped utterances in time order', () => {
    const utts = extractUtterances(RAW);
    expect(utts).toHaveLength(9);
    expect(utts[0]).toEqual({ start: 0.5, text: "Morning, it's Heena calling from Trustpoint." });
  });

  it('tolerates a missing or malformed raw response', () => {
    expect(extractUtterances(null)).toEqual([]);
    expect(extractUtterances({})).toEqual([]);
    expect(extractUtterances({ results: { utterances: 'nope' } })).toEqual([]);
    expect(extractUtterances({ results: { utterances: [{ transcript: '  ' }] } })).toEqual([]);
  });
});

describe('locateEvidence', () => {
  it('returns the surrounding excerpt and the second the quote starts at', () => {
    const result = locateEvidence({
      quote: "Yes, that's no problem at all.",
      transcriptText: TRANSCRIPT,
      transcriptRaw: RAW,
    });
    expect(result.matched).toBe(true);
    expect(result.timestamp_seconds).toBe(13.8);
    // Two blocks either side, with the quote's own block flagged.
    expect(result.excerpt.map((l) => l.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.excerpt.filter((l) => l.is_match).map((l) => l.text)).toEqual([
      "Yes, that's no problem at all.",
    ]);
  });

  it('clamps the excerpt window at the start of the call', () => {
    const result = locateEvidence({
      quote: "Morning, it's Heena calling from Trust Point. Just so you know, this call is recorded.",
      transcriptText: TRANSCRIPT,
      transcriptRaw: RAW,
    });
    expect(result.matched).toBe(true);
    expect(result.excerpt.map((l) => l.index)).toEqual([0, 1, 2]);
    // The stored block merges two utterances, so no single utterance matches;
    // playback still starts at the one carrying the quote's opening words.
    expect(result.timestamp_seconds).toBe(0.5);
  });

  it('reports no match rather than guessing a position', () => {
    const result = locateEvidence({
      quote: 'I confirm you have a fourteen day cooling off period',
      transcriptText: TRANSCRIPT,
      transcriptRaw: RAW,
    });
    expect(result.matched).toBe(false);
    expect(result.excerpt).toEqual([]);
    expect(result.timestamp_seconds).toBeNull();
  });

  it('locates the strongest fragment of a multi-quote narrative', () => {
    const result = locateEvidence({
      quote:
        'Consent was taken: "are you happy for me to share your details with the insurer?" ' +
        'Customer: "Yes." - Call 2: "Is that okay?"',
      transcriptText: TRANSCRIPT,
      transcriptRaw: RAW,
    });
    expect(result.matched).toBe(true);
    expect(result.excerpt.find((l) => l.is_match)?.text).toContain('share your details with the insurer');
    expect(result.timestamp_seconds).toBe(9.1);
  });

  it('offers no timestamp when the passage was never found in the transcript', () => {
    // The scorer reporting an absence, quoting the wording it looked for. Its
    // opening words may well occur in the audio somewhere — cueing playback there
    // would present a coincidence as evidence.
    const result = locateEvidence({
      quote: 'No explicit "are you happy with the fourteen day cooling off period" phrasing found.',
      transcriptText: TRANSCRIPT,
      transcriptRaw: RAW,
    });
    expect(result.matched).toBe(false);
    expect(result.timestamp_seconds).toBeNull();
  });

  it('still locates the quote when the call has no timestamped utterances', () => {
    const result = locateEvidence({
      quote: "and I'll email the documents over today.",
      transcriptText: TRANSCRIPT,
      transcriptRaw: null,
    });
    expect(result.matched).toBe(true);
    expect(result.timestamp_seconds).toBeNull();
  });

  it('declines to locate a quote too short to be distinctive', () => {
    // "Yes, email is fine." is said, but a four-word confirmation occurs all
    // over a sales call — highlighting one occurrence would be a guess.
    const result = locateEvidence({
      quote: 'Yes, email is fine.',
      transcriptText: TRANSCRIPT,
      transcriptRaw: RAW,
    });
    expect(result.matched).toBe(false);
    expect(result.timestamp_seconds).toBeNull();
  });

  it('has nothing to locate for a manual checkpoint with no quote', () => {
    expect(locateEvidence({ quote: null, transcriptText: TRANSCRIPT, transcriptRaw: RAW })).toEqual({
      timestamp_seconds: null,
      matched: false,
      excerpt: [],
    });
  });
});

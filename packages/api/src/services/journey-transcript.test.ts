import { describe, it, expect } from 'vitest';
import {
  buildCombinedTranscript,
  buildCombinedTranscriptWithOffsets,
  callNumberAtOffset,
} from './journey-transcript.js';

const CALLS = [
  { call_date: '2026-07-29', created_at: '2026-07-29', agent_name: 'A Adviser', transcript_text: 'Do you smoke at all?' },
  { call_date: '2026-07-30', created_at: '2026-07-30', agent_name: 'A Adviser', transcript_text: 'Any blood pressure issues?' },
  { call_date: '2026-07-31', created_at: '2026-07-31', agent_name: 'B Adviser', transcript_text: 'Lets go through the alcohol question.' },
];

describe('buildCombinedTranscriptWithOffsets', () => {
  it('produces exactly the same text as the plain builder', () => {
    // Journey scoring and capture depend on the existing format; the offsets
    // variant must not change a single character of it.
    expect(buildCombinedTranscriptWithOffsets(CALLS).text).toBe(buildCombinedTranscript(CALLS));
  });

  it('reports one segment per call, numbered to match the headers', () => {
    const { segments } = buildCombinedTranscriptWithOffsets(CALLS);
    expect(segments.map((s) => s.callNumber)).toEqual([1, 2, 3]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('gives offsets that actually bound each call block', () => {
    const { text, segments } = buildCombinedTranscriptWithOffsets(CALLS);
    for (const s of segments) {
      const block = text.slice(s.start, s.end);
      expect(block.startsWith(`=== Call ${s.callNumber} (`)).toBe(true);
      expect(block).toContain(CALLS[s.index]!.transcript_text);
    }
  });

  it('handles a single call', () => {
    const { segments } = buildCombinedTranscriptWithOffsets([CALLS[0]!]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.start).toBe(0);
  });

  it('handles no calls', () => {
    const { text, segments } = buildCombinedTranscriptWithOffsets([]);
    expect(text).toBe('');
    expect(segments).toEqual([]);
  });
});

describe('callNumberAtOffset', () => {
  const { text, segments } = buildCombinedTranscriptWithOffsets(CALLS);

  it('attributes a quote to the call it came from', () => {
    // This is the whole point: evidence found by searching the combined text must
    // resolve to the right recording, or a supervisor is sent to the wrong call.
    expect(callNumberAtOffset(segments, text.indexOf('smoke'))).toBe(1);
    expect(callNumberAtOffset(segments, text.indexOf('blood pressure'))).toBe(2);
    expect(callNumberAtOffset(segments, text.indexOf('alcohol'))).toBe(3);
  });

  it('attributes the first and last characters of a block correctly', () => {
    for (const s of segments) {
      expect(callNumberAtOffset(segments, s.start)).toBe(s.callNumber);
      expect(callNumberAtOffset(segments, s.end - 1)).toBe(s.callNumber);
    }
  });

  it('returns null in the gap between blocks rather than guessing', () => {
    const gap = segments[0]!.end; // first character of the "\n\n" separator
    expect(callNumberAtOffset(segments, gap)).toBeNull();
  });

  it('returns null outside the text', () => {
    expect(callNumberAtOffset(segments, -1)).toBeNull();
    expect(callNumberAtOffset(segments, text.length + 10)).toBeNull();
  });
});

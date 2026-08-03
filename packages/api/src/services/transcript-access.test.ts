import { describe, it, expect } from 'vitest';
import {
  roleMayReadUnredacted,
  withheldTranscript,
  type TranscriptAccess,
} from './transcript-access.js';

const READABLE: TranscriptAccess = { readable: true, restricted: false };
const WITHHELD: TranscriptAccess = { readable: false, restricted: true };

describe('roleMayReadUnredacted', () => {
  it('allows admin, the role the controller chose', () => {
    expect(roleMayReadUnredacted('admin')).toBe(true);
  });

  it('allows superadmin, who are the processor rather than the firm', () => {
    expect(roleMayReadUnredacted('superadmin')).toBe(true);
  });

  it('refuses supervisor, which is stricter than the 0.1 design on purpose', () => {
    expect(roleMayReadUnredacted('supervisor')).toBe(false);
  });

  it('refuses viewer and adviser', () => {
    expect(roleMayReadUnredacted('viewer')).toBe(false);
    expect(roleMayReadUnredacted('adviser')).toBe(false);
  });

  it('fails closed on a missing or unknown role', () => {
    // A role added later must not inherit access by default.
    expect(roleMayReadUnredacted(null)).toBe(false);
    expect(roleMayReadUnredacted(undefined)).toBe(false);
    expect(roleMayReadUnredacted('')).toBe(false);
    expect(roleMayReadUnredacted('auditor')).toBe(false);
    expect(roleMayReadUnredacted('Admin')).toBe(false);
  });
});

describe('withheldTranscript', () => {
  const row = () => ({
    id: 'call-1',
    file_name: 'call.mp3',
    transcript_text: 'Agent: any heart conditions?',
    transcript_raw: { results: { utterances: [{ transcript: 'any heart conditions' }] } },
  });

  it('passes everything through when the transcript is readable', () => {
    expect(withheldTranscript(row(), READABLE)).toEqual(row());
  });

  it('removes both the readable transcript and the raw payload', () => {
    // transcript_raw holds every word with its timings, so dropping only
    // transcript_text would leave the same content in the JSON beside it.
    const out = withheldTranscript(row(), WITHHELD);
    expect(out.transcript_text).toBeNull();
    expect(out.transcript_raw).toBeNull();
    expect(out.transcript_restricted).toBe(true);
  });

  it('keeps every other field, so the call still renders', () => {
    const out = withheldTranscript(row(), WITHHELD);
    expect(out.id).toBe('call-1');
    expect(out.file_name).toBe('call.mp3');
  });

  it('does not claim a restriction on a call that has no transcript yet', () => {
    // Otherwise an untranscribed call reads as withheld, which sends someone
    // looking for a permission problem that does not exist.
    const out = withheldTranscript(
      { id: 'call-2', transcript_text: null, transcript_raw: null },
      WITHHELD
    );
    expect(out.transcript_restricted).toBeUndefined();
  });

  it('does not mutate the row it was given', () => {
    const original = row();
    withheldTranscript(original, WITHHELD);
    expect(original.transcript_text).toBe('Agent: any heart conditions?');
  });

  it('withholds without flagging when the tenant is not sensitive but access is closed', () => {
    // Defensive: readable=false with restricted=false should still strip. The
    // combination should not arise, but stripping must not depend on the flag.
    const out = withheldTranscript(row(), { readable: false, restricted: false });
    expect(out.transcript_text).toBeNull();
    expect(out.transcript_restricted).toBeUndefined();
  });
});

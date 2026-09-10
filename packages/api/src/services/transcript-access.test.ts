import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOne } from '../db/client.js';
import {
  roleMayReadUnredacted,
  withheldTranscript,
  organisationKeepsUnredacted,
  organisationKeepsHealthUnredacted,
  withheldBreachEvidence,
  type TranscriptAccess,
} from './transcript-access.js';

// Only the two organisation predicates touch the database; everything else here
// is pure and unaffected by the mock.
vi.mock('../db/client.js', () => ({
  queryOne: vi.fn(),
}));

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

// The two organisation predicates are deliberately different widths, and the
// difference is the point: 079 split identity from health so the easier half
// would stop waiting on the harder half's paperwork. These pin that they stay
// split.

const withCategories = (categories: string[] | null) =>
  vi.mocked(queryOne).mockResolvedValueOnce({ categories } as never);

describe('organisationKeepsHealthUnredacted', () => {
  beforeEach(() => vi.mocked(queryOne).mockReset());

  it('is true only when health itself is kept in the clear (DPIA R5)', async () => {
    withCategories(['phi', 'numbers', 'dob']);
    await expect(organisationKeepsHealthUnredacted('org')).resolves.toBe(true);
  });

  it('is false for a tenant that keeps identity unredacted but not health', async () => {
    // The feedback email names the client in its body by design, so suppressing
    // the model's sentence because it might contain a name protects nothing.
    withCategories(['name', 'dob', 'location_city']);
    await expect(organisationKeepsHealthUnredacted('org')).resolves.toBe(false);
  });

  it('fails closed on a fully redacted tenant, an empty column and an unknown org', async () => {
    withCategories([]);
    await expect(organisationKeepsHealthUnredacted('org')).resolves.toBe(false);
    withCategories(null);
    await expect(organisationKeepsHealthUnredacted('org')).resolves.toBe(false);
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);
    await expect(organisationKeepsHealthUnredacted('nope')).resolves.toBe(false);
  });
});

describe('organisationKeepsUnredacted', () => {
  beforeEach(() => vi.mocked(queryOne).mockReset());

  it('stays broader than the health predicate, gating any permitted category', async () => {
    withCategories(['name']);
    await expect(organisationKeepsUnredacted('org')).resolves.toBe(true);
  });
});

// ── withheldBreachEvidence (DPIA R5, action 8) ────────────────────────────────
//
// `evidence` is a verbatim transcript quote, not a paraphrase — services/
// scoring.ts asks the model for "a direct quote from the transcript". These
// tests pin what may leave the platform in a scored payload and what may not.

describe('withheldBreachEvidence', () => {
  const quote = 'I was diagnosed with atrial fibrillation in 2019.';
  const payload = () => ({
    event: 'journey.scored' as const,
    journey_id: 'j-1',
    breaches: [
      { scorecard_item_id: 'i-1', scorecard_item_label: 'Health disclosure taken', severity: 'high', evidence: quote },
      { scorecard_item_id: 'i-2', scorecard_item_label: 'Exclusion explained', severity: 'low', evidence: '' },
    ],
  });

  it('removes every quote and says so, on a tenant keeping health unredacted', () => {
    const out = withheldBreachEvidence(payload(), true);
    expect(out.breaches.map((b) => b.evidence)).toEqual(['', '']);
    expect(out.evidence_withheld).toBe(true);
    // The question and the fact of the breach still travel — that is the shape
    // R5 prescribes, and a payload stripped of them would be useless.
    expect(out.breaches.map((b) => b.scorecard_item_label)).toEqual([
      'Health disclosure taken',
      'Exclusion explained',
    ]);
    expect(out.breaches.map((b) => b.severity)).toEqual(['high', 'low']);
  });

  it('changes nothing for a tenant whose transcripts were redacted at source', () => {
    const input = payload();
    const out = withheldBreachEvidence(input, false);
    expect(out).toBe(input);
    expect(out.evidence_withheld).toBeUndefined();
  });

  it('does not mutate the caller, so a retry cannot resurrect the quote', () => {
    const input = payload();
    withheldBreachEvidence(input, true);
    expect(input.breaches[0]!.evidence).toBe(quote);
  });

  it('claims no restriction where there was no quote to remove', () => {
    // Same rule as withheldTranscript: a sale the AI quoted nothing on must not
    // read as one where something was suppressed.
    const out = withheldBreachEvidence(
      { breaches: [{ scorecard_item_id: 'i-1', scorecard_item_label: 'A checkpoint', severity: 'low', evidence: '' }] },
      true
    );
    expect(out.evidence_withheld).toBeUndefined();
  });

  it('claims no restriction on a clean sale with no breaches at all', () => {
    const out = withheldBreachEvidence({ breaches: [] }, true);
    expect(out.evidence_withheld).toBeUndefined();
  });
});

// The live-session breach frame (WebhookBreachPayload) carries its quote at the
// TOP LEVEL, not inside breaches[]. A filter that only walked breaches[] would
// let that whole event through untouched — which is what a gate placed in
// deliverCallScored rather than deliverWebhook would have done.
describe('withheldBreachEvidence — the top-level evidence shape', () => {
  const quote = 'I was diagnosed with atrial fibrillation in 2019.';

  it('removes a top-level quote and says so', () => {
    const out = withheldBreachEvidence(
      { event: 'session.breach_detected', scorecard_item_label: 'A checkpoint', evidence: quote },
      true
    );
    expect(out.evidence).toBe('');
    expect(out.evidence_withheld).toBe(true);
    expect(out.scorecard_item_label).toBe('A checkpoint');
  });

  it('claims no restriction on a top-level quote that was already empty', () => {
    const out = withheldBreachEvidence({ evidence: '' }, true);
    expect(out.evidence_withheld).toBeUndefined();
  });

  it('leaves a top-level quote alone for a tenant redacted at source', () => {
    const input = { evidence: quote };
    expect(withheldBreachEvidence(input, false)).toBe(input);
  });
});

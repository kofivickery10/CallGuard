import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOne } from '../db/client.js';
import { SORT_CODE_TAG, ACCOUNT_NUMBER_TAG } from './digit-redaction.js';
import {
  resolveRedactCategories,
  REDACTION_CATEGORIES,
  resolveTenantRedactCategories,
  redactForTenant,
  assembleTranscript,
  type TranscriptUtterance,
} from './transcription.js';

vi.mock('../db/client.js', () => ({
  queryOne: vi.fn(),
}));

describe('resolveRedactCategories', () => {
  it('redacts everything when no category is permitted', () => {
    expect(resolveRedactCategories([]).sort()).toEqual([...REDACTION_CATEGORIES].sort());
    expect(resolveRedactCategories().sort()).toEqual([...REDACTION_CATEGORIES].sort());
  });

  it('always redacts pci, even when explicitly asked not to', () => {
    // The schema CHECK in migration 079 should make this unreachable, but the
    // floor must not depend on the database being correct.
    expect(resolveRedactCategories(['pci'])).toContain('pci');
    expect(resolveRedactCategories(['pci', 'phi'])).toContain('pci');
    expect(resolveRedactCategories([...REDACTION_CATEGORIES])).toEqual(['pci']);
  });

  it('drops only the categories permitted', () => {
    const result = resolveRedactCategories(['phi']);
    expect(result).not.toContain('phi');
    expect(result).toContain('pci');
    expect(result).toContain('numbers');
    expect(result).toContain('dob');
  });

  it('supports the identity-only profile (Article 6) without exposing health', () => {
    const identity = [
      'name', 'name_given', 'name_family',
      'dob',
      'email_address',
      'location_address', 'location_city', 'location_state', 'location_zip', 'location_country',
    ];
    const result = resolveRedactCategories(identity);
    // Health stays redacted — this profile deliberately does not need a DPIA.
    expect(result).toContain('phi');
    expect(result).toContain('pci');
    expect(result).toContain('numbers');
    for (const c of identity) expect(result).not.toContain(c);
  });

  it('ignores unknown categories rather than widening exposure', () => {
    // Fail closed: a typo or a stale category name must not drop real redaction.
    const result = resolveRedactCategories(['phhi', 'HEALTH', '']);
    expect(result.sort()).toEqual([...REDACTION_CATEGORIES].sort());
  });

  it('is unaffected by duplicates', () => {
    expect(resolveRedactCategories(['phi', 'phi', 'phi'])).toEqual(
      resolveRedactCategories(['phi'])
    );
  });
});

describe('resolveTenantRedactCategories — the one place batch and live both load policy from', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
  });

  it('resolves the org row into the redact list Deepgram is asked for', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ pii_unredacted_categories: ['phi'] });
    const result = await resolveTenantRedactCategories('org-1');
    expect(result).not.toContain('phi');
    expect(result).toContain('pci');
    expect(result).toContain('numbers');
  });

  it('redacts everything when the org has no row', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect((await resolveTenantRedactCategories('org-1')).sort()).toEqual(
      [...REDACTION_CATEGORIES].sort()
    );
  });

  it('fails closed — redacts everything — when the org row load throws', async () => {
    vi.mocked(queryOne).mockRejectedValueOnce(new Error('connection reset'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await resolveTenantRedactCategories('org-1');
    expect(result.sort()).toEqual([...REDACTION_CATEGORIES].sort());
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('redactForTenant — the single entry point for the in-house bank-detail pass', () => {
  it('redacts bank details in the text', () => {
    const { text, textRedactions } = redactForTenant('Agent: sort code is 20 45 67, thanks.');
    expect(text).toContain(SORT_CODE_TAG);
    expect(text).not.toMatch(/20 45 67/);
    expect(textRedactions).toBeGreaterThan(0);
  });

  it('is inert on text with nothing to redact', () => {
    const { text, textRedactions } = redactForTenant('Agent: hello, how can I help today?');
    expect(text).toBe('Agent: hello, how can I help today?');
    expect(textRedactions).toBe(0);
  });

  it('handles the fully-empty transcript explicitly rather than throwing', () => {
    const { text, textRedactions } = redactForTenant('');
    expect(text).toBe('');
    expect(textRedactions).toBe(0);
  });

  it('redacts the raw payload too when supplied, alongside the text', () => {
    const raw = {
      results: { utterances: [{ transcript: 'account number 87654321', speaker: 0 }] },
    };
    const { raw: redactedRaw, rawRedactions } = redactForTenant('account number 87654321', raw);
    expect(rawRedactions).toBeGreaterThan(0);
    expect((redactedRaw as any).results.utterances[0].transcript).toContain(ACCOUNT_NUMBER_TAG);
  });

  it('leaves raw untouched (and reports zero raw redactions) when no raw payload is supplied', () => {
    const { raw, rawRedactions } = redactForTenant('sort code 20 45 67');
    expect(raw).toBeUndefined();
    expect(rawRedactions).toBe(0);
  });
});

// assembleTranscript is the pure core of transcribeCall (services/transcription.ts):
// speaker-cluster-to-Agent/Customer assignment (stereo pin, mono content-vs-
// positional heuristic), the confidence calculation, and the utterance-joining
// / text fallback chain — described as the highest-risk logic in the pipeline
// since a mislabelled speaker can turn a customer's own words into a false
// compliance breach against the adviser. Extracted so it's testable without
// Deepgram or the DB.
describe('assembleTranscript', () => {
  it('stereo pin: exact attribution regardless of who speaks first', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Hello, how can I help?', channel: 1, start: 0 },
      { transcript: 'Hi, I have a question.', channel: 0, start: 3 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: true,
      pinnedAdviserChannel: 1,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.text).toBe('Agent: Hello, how can I help?\n\nCustomer: Hi, I have a question.');
    expect(result.outcome).toBe('assembled');
    expect(result.speaker_attribution_confidence).toBe(1.0);
    expect(result.adviser_identified_by_content).toBe(true);
  });

  it('stereo without a pinned channel: whoever speaks first is assumed the adviser, confidence 0.7', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Hi there', channel: 0, start: 0 },
      { transcript: 'Hello', channel: 1, start: 2 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: true,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.text).toBe('Agent: Hi there\n\nCustomer: Hello');
    expect(result.speaker_attribution_confidence).toBe(0.7);
    expect(result.adviser_identified_by_content).toBe(false);
  });

  it('mono: content identification overrides the positional guess when it disagrees, confidence 0.8', () => {
    const customerWords = 'My doctor said this was fine'
      .split(' ')
      .map((word) => ({ word, speaker: 0 }));
    const adviserWords =
      'Calls are recorded and you are authorised and regulated and this is whole of market advice'
        .split(' ')
        .map((word) => ({ word, speaker: 1 }));
    const utterances: TranscriptUtterance[] = [
      // Speaker 0 speaks first — the positional heuristic would call them the
      // adviser under monoFirstSpeaker='agent'. Content evidence says otherwise.
      { transcript: 'My doctor said this was fine', speaker: 0, start: 0, words: customerWords },
      {
        transcript: 'Calls are recorded and you are authorised and regulated and this is whole of market advice',
        speaker: 1,
        start: 5,
        words: adviserWords,
      },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.positionalAgentKey).toBe(0);
    expect(result.contentPick?.key).toBe(1);
    expect(result.agentKey).toBe(1);
    expect(result.speaker_attribution_confidence).toBe(0.8);
    expect(result.adviser_identified_by_content).toBe(true);
    expect(result.text).toContain('Customer: My doctor said this was fine');
    expect(result.text).toContain('Agent: Calls are recorded');
  });

  it('mono, inbound (monoFirstSpeaker="agent"): positional heuristic when content abstains, confidence 0.45', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Hello, thanks for calling.', speaker: 0, start: 0 },
      { transcript: 'Hi, I wanted to ask about my quote.', speaker: 1, start: 4 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.contentPick).toBeNull();
    expect(result.positionalAgentKey).toBe(0);
    expect(result.agentKey).toBe(0);
    expect(result.text).toBe('Agent: Hello, thanks for calling.\n\nCustomer: Hi, I wanted to ask about my quote.');
    expect(result.speaker_attribution_confidence).toBe(0.45);
    expect(result.adviser_identified_by_content).toBe(false);
  });

  it('mono, outbound (monoFirstSpeaker="customer"): the OTHER speaker is the adviser when content abstains', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Hello?', speaker: 0, start: 0 },
      { transcript: 'Hi, this is Jane calling about your quote.', speaker: 1, start: 3 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'customer',
      channelFallbackText: '',
    });
    // Speaker 0 spoke first and is assumed the customer on an outbound call,
    // so the adviser is the OTHER speaker (1) — the inverse of the inbound case.
    expect(result.positionalAgentKey).toBe(1);
    expect(result.agentKey).toBe(1);
    expect(result.text).toBe('Customer: Hello?\n\nAgent: Hi, this is Jane calling about your quote.');
    expect(result.speaker_attribution_confidence).toBe(0.45);
  });

  it('mono with 3+ diarised clusters and no content markers: abstains, confidence drops to 0.3', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Hello, thanks for calling.', speaker: 0, start: 0 },
      { transcript: 'Hi, I need help with my account.', speaker: 1, start: 4 },
      { transcript: 'Let me transfer you now.', speaker: 2, start: 10 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.contentPick).toBeNull();
    expect(result.speakerCount).toBe(3);
    expect(result.speaker_attribution_confidence).toBe(0.3);
  });

  // The regression that let a 19-minute health-disclosure call score 92.68 with
  // no Agent turn in its transcript. One cluster means diarisation never
  // separated the parties, so the content pick has a single candidate, finds the
  // adviser's words inside it, and "identifies" the adviser — awarding 0.8 to a
  // transcript where both people are fused together. The speaker count has to be
  // settled before the content branch can lift anything.
  it('mono with ONE diarised cluster: refuses the content lift, confidence 0.3', () => {
    const utterances: TranscriptUtterance[] = [
      {
        transcript:
          "It's Jane calling from Trust Point about the life insurance. " +
          'I was up in neurology yesterday. Calls are recorded. ' +
          'Can I just confirm your date of birth?',
        speaker: 0,
        start: 0,
      },
      { transcript: 'Nothing came up at all, a clean bill of health.', speaker: 0, start: 20 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'customer',
      channelFallbackText: '',
    });
    expect(result.speakerCount).toBe(1);
    // identifyAdviserCluster abstains under two clusters, so the content lift is
    // already unreachable here — the base confidence is the floor value. The
    // lift a call like this CAN still get comes from the cleanup verdict, which
    // is guarded in resolveSpeakerConfidence (see transcript-cleanup.test.ts).
    expect(result.adviser_identified_by_content).toBe(false);
    expect(result.speaker_attribution_confidence).toBe(0.3);
  });

  // Guards the ordering specifically: two clusters plus content markers is the
  // case that legitimately earns 0.8, and the new short-circuit must not eat it.
  it('mono with two clusters still earns the content lift', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Hello?', speaker: 0, start: 0 },
      {
        transcript: 'Calls are recorded. Can I just confirm your date of birth?',
        speaker: 1,
        start: 3,
      },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'customer',
      channelFallbackText: '',
    });
    expect(result.speakerCount).toBe(2);
    expect(result.adviser_identified_by_content).toBe(true);
    expect(result.speaker_attribution_confidence).toBe(0.8);
  });

  it('joins consecutive same-speaker words into one turn and splits a mid-utterance speaker change at word level', () => {
    const utterances: TranscriptUtterance[] = [
      {
        transcript: 'a doctor but no not as far as I am aware to your knowledge',
        speaker: 0,
        start: 0,
        words: [
          { word: 'a', speaker: 0 }, { word: 'doctor', speaker: 0 }, { word: 'but', speaker: 0 },
          { word: 'no', speaker: 0 }, { word: 'not', speaker: 0 }, { word: 'as', speaker: 0 },
          { word: 'far', speaker: 0 }, { word: 'as', speaker: 0 }, { word: 'I', speaker: 0 },
          { word: 'am', speaker: 0 }, { word: 'aware', speaker: 0 },
          { word: 'to', speaker: 1 }, { word: 'your', speaker: 1 }, { word: 'knowledge', speaker: 1 },
        ],
      },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    // A single Deepgram utterance carrying both speakers' words still comes out
    // as two turns, split exactly where the speaker changes.
    expect(result.text).toBe(
      'Agent: a doctor but no not as far as I am aware\n\nCustomer: to your knowledge'
    );
  });

  it('no utterances and no raw channel transcript: outcome "empty", text is ""', () => {
    const result = assembleTranscript({
      utterances: [],
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.outcome).toBe('empty');
    expect(result.text).toBe('');
    expect(result.speakerCount).toBe(0);
  });

  it('no utterances but Deepgram returned a raw channel transcript: falls back to it, unlabelled', () => {
    const result = assembleTranscript({
      utterances: [],
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: 'raw unlabelled transcript text',
    });
    expect(result.outcome).toBe('channel_fallback');
    expect(result.text).toBe('raw unlabelled transcript text');
  });

  it('falls back to the utterance-level speaker label when word-level speakers are absent', () => {
    const utterances: TranscriptUtterance[] = [
      { transcript: 'Good morning, how can I help?', speaker: 0, start: 0 },
      { transcript: 'Hi, quick question about my cover.', speaker: 1, start: 3 },
    ];
    const result = assembleTranscript({
      utterances,
      isMultichannel: false,
      pinnedAdviserChannel: null,
      monoFirstSpeaker: 'agent',
      channelFallbackText: '',
    });
    expect(result.outcome).toBe('assembled');
    expect(result.text).toBe('Agent: Good morning, how can I help?\n\nCustomer: Hi, quick question about my cover.');
  });
});

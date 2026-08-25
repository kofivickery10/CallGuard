import { describe, it, expect } from 'vitest';
import {
  assessSpeakerIntegrity,
  countSpeakerMarkers,
  identifyAdviserCluster,
  swapSpeakerLabels,
  transcriptSupportsAttribution,
  UNRELIABLE_SPEAKER_CONFIDENCE,
} from './speaker-integrity.js';
import { CONSENT_SPEAKER_CONFIDENCE_FLOOR } from './checkpoint-classification.js';

// Mirrors CONFLICT_RATIO in the module under test: below this, the global
// (whole-transcript) heuristic raises nothing at all, so a drift caught only by
// the sliding window is genuinely one the average would have missed.
const CONFLICT_RATIO_FOR_TEST = 0.4;

// A correctly-labelled fragment: the adviser reads the script, the customer
// answers about themselves.
const CORRECT = `Agent: Hi, it's Sam calling. Just to let you know calls are recorded. Can I just take your date of birth?

Customer: It's the third of March.

Agent: Lovely. Now it says, have you ever been diagnosed with any of the following conditions?

Customer: No, nothing like that. My doctor has never mentioned anything.

Agent: Good. And the next question is about medication. I'll just put that down as none.

Customer: My wife keeps telling me to get checked but no.

Agent: That's coming in at £24 per month. Are you happy with that?

Customer: That's too expensive for me right now.`;

// The observed failure: the same conversation with the labels inverted across
// the call, so adviser script sits under "Customer:" and the customer's own
// disclosures sit under "Agent:".
const INVERTED = `Customer: Hi, it's Sam calling. Just to let you know calls are recorded. Can I just take your date of birth?

Agent: It's the third of March.

Customer: Lovely. Now it says, have you ever been diagnosed with any of the following conditions?

Agent: No, nothing like that. My doctor has never mentioned anything.

Customer: Good. And the next question is about medication. I'll just put that down as none.

Agent: My wife keeps telling me to get checked but no.

Customer: That's coming in at £24 per month. Are you happy with that?

Agent: That's too expensive for me right now.`;

describe('countSpeakerMarkers', () => {
  it('attributes role markers to the label they appear under', () => {
    const counts = countSpeakerMarkers(CORRECT);
    expect(counts.adviserUnderAgent).toBeGreaterThan(0);
    expect(counts.customerUnderCustomer).toBeGreaterThan(0);
    expect(counts.adviserUnderCustomer).toBe(0);
    expect(counts.customerUnderAgent).toBe(0);
  });

  it('is unaffected by turn counts, which always alternate after merging', () => {
    // transcription.ts merges consecutive same-speaker utterances, so the two
    // labels always have near-equal turn counts — only content is evidence.
    const counts = countSpeakerMarkers(INVERTED);
    expect(counts.adviserUnderCustomer).toBeGreaterThan(counts.adviserUnderAgent);
  });
});

describe('assessSpeakerIntegrity', () => {
  it('passes a correctly-labelled transcript', () => {
    const result = assessSpeakerIntegrity(CORRECT, 'confirmed');
    expect(result.flag).toBeNull();
  });

  it('flags inverted labels', () => {
    const result = assessSpeakerIntegrity(INVERTED, 'unclear');
    expect(result.flag).toBe('inverted_labels');
  });

  it("escalates when the model said 'confirmed' but content disagrees", () => {
    // The exact regression: the cleanup pass returned 'confirmed' on a
    // scrambled transcript, and that verdict is the only thing that lifts
    // confidence above the consent-gate floor.
    const result = assessSpeakerIntegrity(INVERTED, 'confirmed');
    expect(result.flag).toBe('model_verdict_conflict');
    expect(result.detail).toContain("model said 'confirmed'");
  });

  it('flags a mid-call drift the whole-transcript average would hide', () => {
    // The real failure mode: diarisation was correct for the opening and
    // inverted for the rest. On the production call this reproduces, the
    // whole-transcript misplacement ratio was 0.38 — under every global
    // threshold — while the worst sustained run was 75%.
    // Two-thirds correctly labelled, one third inverted — the proportions of
    // the production call this reproduces.
    const drifted = `${CORRECT}\n\n${CORRECT}\n\n${INVERTED}`;
    const result = assessSpeakerIntegrity(drifted, 'unclear');
    expect(result.flag).toBe('partial_inversion');
    // Precisely the case a global ratio misses.
    expect(result.inversionRatio).toBeLessThan(CONFLICT_RATIO_FOR_TEST);
    expect(result.worstWindowRatio).toBeGreaterThanOrEqual(0.65);
  });

  it('changes nothing when there is too little evidence to judge', () => {
    const short = `Agent: Hello?\n\nCustomer: Hi.\n\nAgent: Is now a good time?\n\nCustomer: Not really.`;
    const result = assessSpeakerIntegrity(short, 'confirmed');
    expect(result.flag).toBeNull();
    expect(result.detail).toContain('insufficient evidence');
  });

  it('does not flag a customer merely echoing a price back', () => {
    // One adviser-ish phrase under Customer against a clear adviser majority
    // must not trip the detector — false positives cost manual review on
    // perfectly good calls.
    const echoed = `Agent: Just to confirm, calls are recorded. Can I just take your date of birth?

Customer: Sure. So that's £24 per month?

Agent: That's right. Now it says, have you ever been diagnosed with anything?

Customer: No. My doctor says I'm fine.

Agent: Good. I'll just put that down. The next question is about your job.

Customer: My employer is a haulage firm.

Agent: Perfect, and are you happy with that price?`;
    expect(assessSpeakerIntegrity(echoed, 'confirmed').flag).toBeNull();
  });

  it('pins unreliable transcripts below the consent-gate floor', () => {
    // The whole point of the flag: consent gates must route to manual review
    // rather than auto-score off labels we do not trust.
    expect(UNRELIABLE_SPEAKER_CONFIDENCE).toBeLessThan(CONSENT_SPEAKER_CONFIDENCE_FLOOR);
  });
});

describe('identifyAdviserCluster', () => {
  // Shaped after the real Deepgram output that caused the 33-minute inversion:
  // the customer's opening "Hello?" landed in the ADVISER's cluster, so the
  // positional heuristic ("first speaker, flipped for outbound") named the wrong
  // cluster and inverted the whole call. Content is unambiguous where position
  // is not.
  const adviserSpeech =
    'Hello? Hi, it is Sam from the firm. Just to let you know calls are recorded. ' +
    'Can I just take your date of birth? Now it says, have you ever been diagnosed ' +
    'with any of the following? I will just put that down. That is £24 per month. ' +
    'Are you happy with that?';
  const customerSpeech =
    'Speak now. Perfect. My doctor never mentioned it. My wife keeps on at me about it. ' +
    'That is too expensive for me.';

  it('picks the adviser from content even when they did not speak first', () => {
    const pick = identifyAdviserCluster([
      { key: 0, text: adviserSpeech },
      { key: 1, text: customerSpeech },
    ]);
    expect(pick?.key).toBe(0);
  });

  it('is unaffected by cluster ordering', () => {
    const pick = identifyAdviserCluster([
      { key: 1, text: customerSpeech },
      { key: 0, text: adviserSpeech },
    ]);
    expect(pick?.key).toBe(0);
  });

  it('handles a third party without mistaking them for the adviser', () => {
    // Joint applicants and interpreters are routine in protection advice; every
    // non-adviser cluster is collapsed into "Customer" downstream, so only the
    // adviser needs identifying.
    const pick = identifyAdviserCluster([
      { key: 0, text: adviserSpeech },
      { key: 1, text: customerSpeech },
      { key: 2, text: 'My husband handles the money. I can t afford much.' },
    ]);
    expect(pick?.key).toBe(0);
  });

  it('abstains when two clusters both read adviser script', () => {
    // An adviser-to-adviser transfer. Collapsing the second adviser into
    // "Customer" would let their words satisfy checkpoints the first adviser
    // was meant to deliver — a false pass. Abstaining keeps confidence low.
    expect(
      identifyAdviserCluster([
        { key: 0, text: adviserSpeech },
        { key: 1, text: adviserSpeech },
      ])
    ).toBeNull();
  });

  it('abstains when nobody looks like an adviser', () => {
    expect(
      identifyAdviserCluster([
        { key: 0, text: 'Yeah. No. Maybe.' },
        { key: 1, text: 'Right. Okay then.' },
      ])
    ).toBeNull();
  });

  it('abstains on a single cluster', () => {
    expect(identifyAdviserCluster([{ key: 0, text: adviserSpeech }])).toBeNull();
  });
});

describe('swapSpeakerLabels', () => {
  it('flips every label and leaves turn order and text untouched', () => {
    const before = 'Agent: Hello there.\nCustomer: Hi.\nAgent: Right.';
    expect(swapSpeakerLabels(before)).toBe(
      'Customer: Hello there.\nAgent: Hi.\nCustomer: Right.'
    );
  });

  it('is its own inverse', () => {
    expect(swapSpeakerLabels(swapSpeakerLabels(INVERTED))).toBe(INVERTED);
  });

  // A label is only a label at the start of a turn. "Agent:" inside a sentence
  // is speech, and flipping it would corrupt the transcript.
  it('ignores the words mid-line', () => {
    const line = 'Customer: I asked the Agent: why?';
    expect(swapSpeakerLabels(line)).toBe('Agent: I asked the Agent: why?');
  });
});

describe('transcriptSupportsAttribution', () => {
  it('accepts a normal two-party transcript', () => {
    const r = transcriptSupportsAttribution(CORRECT, null);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  // Andrew Kerr's sale: diarisation returned one cluster, so the whole
  // 19-minute call sits under 'Customer:' with no Agent turn. It scored 92.68.
  it('refuses a transcript where the whole call is one party', () => {
    const r = transcriptSupportsAttribution(
      "Customer: It's Jane from Trust Point about the life insurance. " +
        'I was up in neurology yesterday, clean bill of health.',
      null
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('never separated');
  });

  it('refuses either one-sided direction', () => {
    expect(transcriptSupportsAttribution('Agent: Hello. Anyone there?', null).ok).toBe(false);
    expect(transcriptSupportsAttribution('Customer: Hello?', null).ok).toBe(false);
  });

  it('refuses a transcript with no labels at all', () => {
    const r = transcriptSupportsAttribution('Hello, is anyone there?', null);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no speaker labels');
  });

  it('refuses an empty or missing transcript', () => {
    expect(transcriptSupportsAttribution('', null).ok).toBe(false);
    expect(transcriptSupportsAttribution(null, null).ok).toBe(false);
  });

  // Two labels present, but the content says they are on the wrong parties.
  // Previously this only gated consent items; everything else scored on it.
  it('refuses a well-formed transcript whose labels are flagged', () => {
    const r = transcriptSupportsAttribution(CORRECT, 'inverted_labels');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('inverted_labels');
  });

  it('refuses on any integrity flag, not just inversion', () => {
    for (const flag of ['partial_inversion', 'role_marker_conflict', 'model_verdict_conflict'] as const) {
      expect(transcriptSupportsAttribution(CORRECT, flag).ok).toBe(false);
    }
  });
});

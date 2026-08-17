import { describe, it, expect } from 'vitest';
import {
  redactBankDetails,
  redactBankDetailsInRaw,
  SORT_CODE_TAG,
  ACCOUNT_NUMBER_TAG,
} from './digit-redaction.js';

const r = (s: string) => redactBankDetails(s).text;

describe('redactBankDetails — what must be removed', () => {
  it('removes a sort code given as digits', () => {
    expect(r('Agent: And the sort code is 20 45 67 for that account.')).toBe(
      `Agent: And the sort code is ${SORT_CODE_TAG} for that account.`
    );
  });

  it('removes a sort code read aloud as words', () => {
    // The case that made `numbers` load-bearing in the first place: an entity
    // tagger does not see "one one, oh six" as a payment instrument.
    const out = r('Customer: The sort code, it is one one, oh six, four two.');
    expect(out).toContain(SORT_CODE_TAG);
    expect(out).not.toMatch(/one one|oh six|four two/);
  });

  it('removes an account number given as a solid run', () => {
    expect(r('Agent: account number 87654321, is that right?')).toBe(
      `Agent: account number ${ACCOUNT_NUMBER_TAG}, is that right?`
    );
  });

  it('handles the double/treble shorthand people use reading digits', () => {
    const out = r('Customer: Sort code is double four, two one, treble six.');
    expect(out).toContain(SORT_CODE_TAG);
    expect(out).not.toMatch(/double four|treble six/);
  });

  it('survives the self-correction people actually do mid-number', () => {
    const out = r(
      "Customer: The sort code is two zero, sorry, two one, four five, six seven."
    );
    expect(out).toContain(SORT_CODE_TAG);
    expect(out).not.toMatch(/four five|six seven/);
  });

  it('removes both numbers when they are dictated together', () => {
    const out = r(
      'Agent: sort code 20 45 67 and the account number is 8 7 6 5 4 3 2 1 lovely.'
    );
    expect(out).not.toMatch(/\d/);
    expect(out).toContain('lovely');
  });

  it('catches the phrasing with no "number" in it', () => {
    const out = r('Agent: which bank account does that come out of? 12345678.');
    expect(out).toContain(ACCOUNT_NUMBER_TAG);
    expect(out).not.toContain('12345678');
  });

  it('catches a number read back in fragments with acknowledgements between', () => {
    // The shape taken from real Trust Point calls, where the stored transcript
    // reads "It's [NUMERICAL_PII_1] Mhmm. [NUMERICAL_PII_2] Yeah.
    // [NUMERICAL_PII_3]". Counting digits per contiguous run sees three
    // two-digit runs, masks none, and leaves the sort code in the clear while
    // appearing to have worked.
    const out = r("Agent: And the sort code?\n\nCustomer: It's 20 45\n\nAgent: Mhmm.\n\nCustomer: 67 89\n\nAgent: Yeah.");
    expect(out).not.toMatch(/\d/);
    expect(out).toContain(SORT_CODE_TAG);
  });

  it('catches digits split across a speaker change', () => {
    const out = r('Agent: sort code and account number please?\n\nCustomer: Yep, 20 45 67.\n\nAgent: Perfect. And?\n\nCustomer: 8 7 6 5 4 3 2 1.');
    expect(out).not.toMatch(/\d/);
  });

  it("catches the agent's read-back as well as the customer's dictation", () => {
    // "Read that back to you. 20 45 67" — the same digits a second time, and
    // masking only the first occurrence would defeat the whole exercise.
    const out = r("Agent: sort code please?\n\nCustomer: 20 45 67.\n\nAgent: Read that back to you. 20 45 67. Correct?");
    expect(out).not.toMatch(/\d/);
  });

  it('catches a partial read, rather than trusting an odd length', () => {
    // A misheard or partial number is not safe to keep just because it did not
    // come out at exactly 6 or 8 digits.
    const out = r('Agent: sort code 20 45 6');
    expect(out).toContain(SORT_CODE_TAG);
    expect(out).not.toMatch(/\d/);
  });

  it('handles more than one disclosure in the same call', () => {
    const out = r(
      'Agent: sort code 20 45 67.\n\nCustomer: Yes.\n\nAgent: And the sort code on the second one, 11 06 42.'
    );
    expect(out.match(new RegExp(SORT_CODE_TAG.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(out).not.toMatch(/\d/);
  });

  it('is case- and spacing-insensitive on the anchor', () => {
    expect(r('SORT CODE 204567')).toContain(SORT_CODE_TAG);
    expect(r('sortcode 204567')).toContain(SORT_CODE_TAG);
    expect(r('Account No. 87654321')).toContain(ACCOUNT_NUMBER_TAG);
  });

  it('catches digits stated before a referential anchor', () => {
    // Read-back phrasing: the customer states the number, then someone names
    // what it was a moment later. Every anchor above only looks forward, so
    // this is the shape that leaked a full sort code before the backward
    // window existed.
    const out = r("Customer: It's 20 45 67. Agent: Lovely, and that's the sort code, yes?");
    expect(out).not.toMatch(/\d/);
    expect(out).toContain(SORT_CODE_TAG);
  });

  it('catches spoken-word digits stated before the anchor', () => {
    const out = r('Customer: two zero, four five, six seven — that\'s the sort code.');
    expect(out).not.toMatch(/two zero|four five|six seven/);
    expect(out).toContain(SORT_CODE_TAG);
  });

  it('catches an account number read back before the anchor', () => {
    const out = r("Customer: 8 7 6 5 4 3 2 1, that's my account number.");
    expect(out).not.toMatch(/\d/);
    expect(out).toContain(ACCOUNT_NUMBER_TAG);
  });

  it('catches a read-back interleaved with acknowledgements before the anchor', () => {
    const out = r(
      "Customer: It's 20 45\n\nAgent: Mhmm.\n\nCustomer: 67 89\n\nAgent: Yeah, that's the sort code."
    );
    expect(out).not.toMatch(/\d/);
    expect(out).toContain(SORT_CODE_TAG);
  });

  it("catches the agent stating the number before naming it", () => {
    const out = r('Agent: 20 45 67 is the sort code we have on file, correct?');
    expect(out).not.toMatch(/\d/);
    expect(out).toContain(SORT_CODE_TAG);
  });
});

describe('redactBankDetails — what must survive', () => {
  it('leaves a weight answer alone', () => {
    const s = 'Customer: I am about 17 stone 7, so maybe 111 kilos.';
    expect(r(s)).toBe(s);
  });

  it('leaves height, age and alcohol units alone', () => {
    const s = 'Customer: five foot eleven, I am 62, and about 14 units a week.';
    expect(r(s)).toBe(s);
  });

  it('leaves a blood pressure reading alone', () => {
    const s = 'Customer: it was 140 over 90 last time they checked.';
    expect(r(s)).toBe(s);
  });

  it('leaves premiums and cover amounts alone', () => {
    const s = 'Agent: so that is £32.50 a month for £150,000 of cover over 25 years.';
    expect(r(s)).toBe(s);
  });

  it('does not eat a health answer that follows a bank question', () => {
    // The window terminators earning their keep: the subject changed, and the
    // numbers after it are answers we need for reconciliation.
    const out = r(
      'Agent: sort code 20 45 67. And your weight, what are we putting down? Customer: 17 stone 7.'
    );
    expect(out).toContain(SORT_CODE_TAG);
    expect(out).toContain('17 stone 7');
  });

  it('leaves a short numeric answer near the phrase alone', () => {
    const s = 'Customer: on the account number question, yes, I have 2 accounts.';
    expect(r(s)).toBe(s);
  });

  it('does nothing when the phrase never appears', () => {
    const s = 'Agent: any heart conditions, diabetes, or high cholesterol?';
    expect(r(s)).toBe(s);
  });

  it('does nothing to an already-redacted transcript', () => {
    // When `numbers` is redacted at source there are no runs left to find, and
    // this must not mangle the tags Deepgram left behind.
    const s = 'Agent: sort code [NUMBER] and account number [ACCOUNT_NUMBER].';
    expect(r(s)).toBe(s);
  });

  it('leaves a run of indexed placeholders completely alone', () => {
    // Measured against 19 of 71 real transcripts. Deepgram's tags carry an index
    // digit, so this dialogue — the exact shape of a source-redacted call —
    // totals enough digits to trip the floor. Masking them would replace
    // "[NUMERICAL_PII_1]" with "[SORT_CODE]" and lose which entity type it was,
    // on a transcript that was already safe.
    const s =
      "Agent: And your sort code, please?\n\nCustomer: It's [NUMERICAL_PII_1] Mhmm. [NUMERICAL_PII_2] Yeah. [NUMERICAL_PII_3]";
    expect(r(s)).toBe(s);
  });

  it('leaves the varied tags Deepgram actually emits for the same field alone', () => {
    // The same sort code comes back as any of these depending on the call.
    const s =
      'Agent: sort code [CVV_1] Yep. And account is [BANK_ACCOUNT_1]. Sort code [ROUTING_NUMBER_2], account number [PHONE_NUMBER_1] [PHONE_NUMBER_2].';
    expect(r(s)).toBe(s);
  });

  it('still catches real digits sitting beside placeholders', () => {
    // A partially-redacted window must not become a hiding place.
    const out = r('Agent: sort code [NUMERICAL_PII_1] and the rest is 45 67 89.');
    expect(out).toContain('[NUMERICAL_PII_1]');
    expect(out).toContain(SORT_CODE_TAG);
    expect(out).not.toMatch(/45|67|89/);
  });

  it('is idempotent', () => {
    const once = r('Agent: sort code 20 45 67 please.');
    expect(r(once)).toBe(once);
  });

  it('leaves health answers before an unrelated later bank question alone', () => {
    // The "units" terminator earning its keep on the backward window too: the
    // digits here are the answer to a health question, not a read-back, and
    // the sentence after them is a fresh request rather than a confirmation.
    const s =
      'Customer: five foot eleven, I am 62, and about 14 units a week. Agent: Great. Now can I take your sort code?';
    expect(r(s)).toBe(s);
  });

  it('leaves a blood pressure reading before an unrelated sort code question alone', () => {
    const s = 'Customer: it was 140 over 90 last time they checked. Agent: OK. And the sort code?';
    expect(r(s)).toBe(s);
  });

  it('leaves a cover amount before an unrelated sort code question alone', () => {
    const s =
      'Agent: so that is £32.50 a month for £150,000 of cover over 25 years. And the sort code?';
    expect(r(s)).toBe(s);
  });

  it('leaves a short age answer before the anchor alone, under the digit floor', () => {
    const s = 'Customer: I am 62. Agent: Right, sort code please?';
    expect(r(s)).toBe(s);
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(r('')).toBe('');
    expect(r('   ')).toBe('   ');
  });

  it('leaves a policy number alone when a bank question follows with only acknowledgement glue between', () => {
    // BACK_GLUE alone cannot tell this apart from a read-back: "Thanks. And
    // your " is pure acknowledgement glue. But there is no copula linking the
    // digits to "bank account" — this is a fresh request, not a confirmation
    // of what was just said — and a policy number is itself a reconciliation
    // field, so masking it as [ACCOUNT_NUMBER] would be a direct loss.
    const s =
      'Customer: My policy number is 12345678. Agent: Thanks. And your bank account?';
    expect(r(s)).toBe(s);
  });

  it('leaves a date of birth alone when a sort code question follows with only acknowledgement glue between', () => {
    // Same shape as the policy-number case, and "And the sort code please?"
    // has no verb at all for a substantive-verb test to catch — it is a bare
    // noun-phrase request. A date of birth is a core application field, so
    // masking it as [SORT_CODE] would destroy exactly the answer
    // reconciliation exists to compare.
    const s = 'Customer: 14 06 1978. Agent: Great, thanks. And the sort code please?';
    expect(r(s)).toBe(s);
  });
});

describe('redactBankDetailsInRaw', () => {
  it('redacts utterance transcripts inside the payload', () => {
    const { raw } = redactBankDetailsInRaw({
      results: {
        utterances: [{ transcript: 'sort code 20 45 67', speaker: 0 }],
      },
    });
    const utterance = (raw as any).results.utterances[0];
    expect(utterance.transcript).toContain(SORT_CODE_TAG);
    expect(utterance.speaker).toBe(0);
  });

  it('masks a long digit run at word level, where there is no context to anchor on', () => {
    // transcript_raw holds every word separately, so the anchored pass cannot see
    // them. Masking text alone would leave the digits in the JSON beside it — and
    // the per-answer timestamp work reads that JSON directly.
    const { raw, redactions } = redactBankDetailsInRaw({
      words: [
        { word: '87654321', punctuated_word: '87654321', start: 1 },
        { word: 'seventeen', punctuated_word: 'Seventeen', start: 2 },
      ],
    });
    const words = (raw as any).words;
    expect(words[0].word).toBe(ACCOUNT_NUMBER_TAG);
    expect(words[0].punctuated_word).toBe(ACCOUNT_NUMBER_TAG);
    expect(words[0].start).toBe(1);
    expect(words[1].word).toBe('seventeen');
    expect(redactions).toBeGreaterThan(0);
  });

  it('leaves short word-level numbers alone', () => {
    const { raw } = redactBankDetailsInRaw({
      words: [{ word: '17', punctuated_word: '17' }, { word: '140', punctuated_word: '140' }],
    });
    expect((raw as any).words.map((w: any) => w.word)).toEqual(['17', '140']);
  });

  it('preserves timings and structure so word-level features still work', () => {
    const input = {
      metadata: { duration: 123.4 },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'account number 87654321',
                words: [{ word: '87654321', start: 4.2, end: 5.1, confidence: 0.9 }],
              },
            ],
          },
        ],
      },
    };
    const { raw } = redactBankDetailsInRaw(input);
    const alt = (raw as any).results.channels[0].alternatives[0];
    expect(alt.transcript).toContain(ACCOUNT_NUMBER_TAG);
    expect(alt.words[0].start).toBe(4.2);
    expect(alt.words[0].end).toBe(5.1);
    expect(alt.words[0].confidence).toBe(0.9);
    expect((raw as any).metadata.duration).toBe(123.4);
  });

  it('does not mutate the payload it was given', () => {
    const input = { results: { utterances: [{ transcript: 'sort code 20 45 67' }] } };
    redactBankDetailsInRaw(input);
    expect(input.results.utterances[0]!.transcript).toBe('sort code 20 45 67');
  });

  it('never throws on an unexpected shape, so it cannot block transcription', () => {
    for (const input of [null, undefined, 42, 'a string', [], {}, { words: null }]) {
      expect(() => redactBankDetailsInRaw(input)).not.toThrow();
    }
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { redactValuesForLearning } from './document-profile-learner.js';
import {
  ROYAL_LONDON_PACK,
  METLIFE_SUMMARY,
  PORTAL_EXPORT,
  PORTAL_WITHDRAWN_SECTION,
} from './application-pdf.fixtures.js';

// ============================================================
// Values sent to Claude to LEARN a document profile, before this fix: an
// unrecognised insurer application went to Anthropic up to HEAD_CHARS +
// TAIL_CHARS unredacted — a customer's name, date of birth, home address,
// policy number and health disclosures included. Every fixture used below is
// synthesised: application-pdf.fixtures.ts's own header says customer details
// are replaced with obvious placeholders, and nothing here is copied from
// docs/trustpoint/samples/ (real, gitignored sale data).
// ============================================================

describe('redactValuesForLearning — direct value masking', () => {
  it('masks a name given by a "Label:" field, whatever the label phrasing', () => {
    const out = redactValuesForLearning('Your name: Mr Jonathan Carrow\nCustomer name: Mr Jonathan Carrow\n');
    expect(out).not.toContain('Jonathan Carrow');
    expect(out).toContain('[NAME]');
  });

  it('does not mask a product or company name as if it were personal', () => {
    const out = redactValuesForLearning('Company name: Sample Firm\nProduct name: Personal Menu Plan\n');
    expect(out).toContain('Sample Firm');
    expect(out).toContain('Personal Menu Plan');
  });

  it('masks a date of birth given against a DOB label', () => {
    const out = redactValuesForLearning('DOB: 14/10/1969\nDate of birth: 14/10/1969\n');
    expect(out).not.toContain('14/10/1969');
    expect(out).toContain('[DOB]');
  });

  it('masks an address, including one that wraps onto its own lines', () => {
    const out = redactValuesForLearning(
      'Address: 14 Templars Way\nGrantham\nLincolnshire\nNG33 5PS\nEmail:\n'
    );
    expect(out).not.toContain('Templars Way');
    expect(out).not.toContain('Grantham');
    expect(out).not.toContain('NG33 5PS');
    expect(out).toContain('[LOCATION_ADDRESS]');
    // The next real field must still be readable — the wrap must stop there.
    expect(out).toContain('Email:');
  });

  it('masks a policy number, both as a labelled field and stated inline', () => {
    const out = redactValuesForLearning(
      'Policy number: EPH000001\nYour plan number 900000001\nApplication number: 900000001\n'
    );
    expect(out).not.toContain('EPH000001');
    expect(out).not.toContain('900000001');
    expect(out).toContain('[POLICY_NUMBER]');
  });

  it('masks a health answer given under a generic "Your answer(s):" delimiter', () => {
    const out = redactValuesForLearning(
      'Have you ever had, or do you currently have, any form of cancer?\nYour answer(s):\nBowel cancer, diagnosed 2019\n'
    );
    expect(out).not.toContain('Bowel cancer');
    expect(out).not.toContain('2019');
    // The question itself is structure the learner needs, and must survive.
    expect(out).toContain('any form of cancer?');
  });

  it('masks a health answer recorded on a quote-portal timestamped line', () => {
    const out = redactValuesForLearning(
      '29/07/2026 12:03 - Type 2 diabetes (A Adviser)\nHave you ever had diabetes?\tQ\nA\n'
    );
    expect(out).not.toContain('Type 2 diabetes');
    expect(out).not.toContain('A Adviser');
    expect(out).toContain('[VALUE]');
    expect(out).toContain('[NAME]');
  });

  it('leaves a non-answer marker alone rather than masking it as if it were a value', () => {
    const out = redactValuesForLearning('Evening phone number: Unanswered\n');
    expect(out).toContain('Unanswered');
    expect(out).not.toContain('[PHONE_NUMBER]');
  });

  it('preserves the delimiter, section markers and question text a config depends on', () => {
    const out = redactValuesForLearning(ROYAL_LONDON_PACK);
    expect(out).toContain('APPLICATION FORM');
    expect(out).toContain('YOUR PERSONAL QUOTE');
    expect(out).toContain('Your answer(s):');
    expect(out).toContain('Have you ever smoked, vaped, used e-cigarettes, tobacco or nicotine products?');
    expect(out).toContain('●'); // choice bullet
  });

  it('preserves label_value field labels while masking their values', () => {
    const out = redactValuesForLearning(METLIFE_SUMMARY);
    for (const label of ['Policy number', 'Name', 'Address', 'Email', 'DOB', 'Monthly premium']) {
      expect(out).toContain(label);
    }
  });

  it('preserves the question_marker structure (question marker, options prefix)', () => {
    const out = redactValuesForLearning(PORTAL_EXPORT);
    expect(out).toContain('\tQ');
    expect(out).toContain('Options - ');
    expect(out).toContain('How tall are you?');
  });

  it('handles an unattributed answer line (the withdrawn-disclosures shape) without leaking the value', () => {
    const out = redactValuesForLearning(PORTAL_WITHDRAWN_SECTION);
    // Every recorded-by name is masked, and none of the disclosed values —
    // including the family-history answer given, then withdrawn, three
    // minutes later. "Any other cancer" and "Father" legitimately survive as
    // Options- choice vocabulary a few lines below each (the same reasoning
    // as Royal London's bullet list), so the checks are scoped to the
    // timestamp lines that actually disclosed them rather than the whole
    // document.
    expect(out).not.toContain('Lewis Moore');
    expect(out).not.toMatch(/09:53 - Any other cancer/);
    expect(out).not.toMatch(/09:55 - Father/);
    expect(out).toContain('09:53 - [VALUE] ([NAME])');
  });
});

// ============================================================
// What actually reaches Anthropic. Mirrors scoring.test.ts's approach: no
// static top-level import of document-profile-learner.ts, because that would
// pull in config.ts (and freeze config.anthropic.apiKey at '') before this
// file's beforeAll gets a chance to set ANTHROPIC_API_KEY.
// ============================================================
let capturedParams: Array<{ messages: Array<{ content: Array<{ text: string }> }> }> = [];

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      stream: (params: { messages: Array<{ content: Array<{ text: string }> }> }) => {
        capturedParams.push(params);
        return {
          finalMessage: async () => ({
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [
              {
                type: 'tool_use',
                input: {
                  insurer: 'Royal London',
                  product: 'Personal Menu Plan',
                  strategy: 'question_answer',
                  detect_patterns: ['PERSONAL MENU PLAN', 'Your answer(s):'],
                  answer_delimiter: 'Your answer(s):',
                  section_start: 'APPLICATION FORM',
                  section_end: 'YOUR PERSONAL QUOTE',
                  choice_bullet: '●',
                  notes: null,
                },
              },
            ],
          }),
        };
      },
    };
  },
}));

let learnDocumentProfile: typeof import('./document-profile-learner.js').learnDocumentProfile;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY ||= 'test-key-not-real';
  ({ learnDocumentProfile } = await import('./document-profile-learner.js'));
});

beforeEach(() => {
  capturedParams = [];
});

describe('learnDocumentProfile — nothing unredacted reaches Anthropic', () => {
  // Values a customer would recognise as their own, taken from the fixtures'
  // own synthetic answers — every one of these must be gone from what the
  // mock captured as having been sent, whichever fixture it came from.
  const SENSITIVE_VALUES = [
    // Royal London
    '900000001', 'HGV Driver', '05/05/2026', '111.1kg', 'sample applicant',
    // MetLife
    'EPH000001', '14/10/1969', 'AB12 3CD', '1 Sample Street', 'Sample Customer',
    'sample@example.invalid', '07000000000',
    // Portal export
    '18/11/1971', 'Pupil Support Assistant', 'A Adviser',
  ];

  function assertNoRawValueSent() {
    expect(capturedParams.length).toBeGreaterThan(0);
    const sentText = capturedParams
      .flatMap((p) => p.messages.flatMap((m) => m.content.map((c) => c.text)))
      .join('\n');
    for (const value of SENSITIVE_VALUES) {
      expect(sentText).not.toContain(value);
    }
  }

  it('does not send a raw value from the Royal London pack', async () => {
    const { learned } = await learnDocumentProfile(ROYAL_LONDON_PACK);
    expect(learned.proposal.insurer).toBe('Royal London'); // sanity: the mock ran
    assertNoRawValueSent();
  });

  it('does not send a raw value from the MetLife summary', async () => {
    await learnDocumentProfile(METLIFE_SUMMARY);
    assertNoRawValueSent();
  });

  it('does not send a raw value from the quote-portal export', async () => {
    await learnDocumentProfile(PORTAL_EXPORT);
    assertNoRawValueSent();
  });
});

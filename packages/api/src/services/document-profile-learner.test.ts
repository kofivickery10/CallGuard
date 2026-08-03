import { describe, it, expect } from 'vitest';
import {
  toProposal,
  verifyProposal,
  sampleForLearning,
  isUsableAnswerPattern,
  type ProfileProposal,
} from './document-profile-learner.js';
import {
  ROYAL_LONDON_PACK,
  ROYAL_LONDON_CONFIG,
  METLIFE_SUMMARY,
  METLIFE_CONFIG,
  PORTAL_EXPORT,
  PORTAL_CONFIG,
} from './application-pdf.fixtures.js';

const GOOD_RL: ProfileProposal = {
  insurer: 'Royal London',
  product: 'Personal Menu Plan',
  strategy: 'question_answer',
  detect_patterns: ['PERSONAL MENU PLAN', 'Your answer(s):'],
  parse_config: ROYAL_LONDON_CONFIG,
  notes: null,
};

const GOOD_METLIFE: ProfileProposal = {
  insurer: 'MetLife',
  product: 'EverydayProtect',
  strategy: 'label_value',
  detect_patterns: ['MetLife EverydayProtect', 'Summary of application details'],
  parse_config: METLIFE_CONFIG,
  notes: null,
};

describe('toProposal', () => {
  it('maps the tool output into a parse config', () => {
    const p = toProposal({
      insurer: 'Royal London',
      product: 'Personal Menu Plan',
      strategy: 'question_answer',
      detect_patterns: ['PERSONAL MENU PLAN', 'Your answer(s):'],
      answer_delimiter: 'Your answer(s):',
      section_start: 'APPLICATION FORM',
      section_end: 'YOUR PERSONAL QUOTE',
      choice_bullet: '●',
      unanswered_markers: ['Unanswered'],
      notes: 'A 29-page pack.',
    });
    expect(p.strategy).toBe('question_answer');
    expect(p.parse_config.answerDelimiter).toBe('Your answer(s):');
    expect(p.parse_config.sectionStart).toBe('APPLICATION FORM');
    expect(p.parse_config.sectionEnd).toBe('YOUR PERSONAL QUOTE');
    expect(p.notes).toBe('A 29-page pack.');
  });

  it('defaults to question_answer for an unrecognised strategy', () => {
    expect(toProposal({ strategy: 'something-else' }).strategy).toBe('question_answer');
  });

  it('survives a malformed or empty tool payload', () => {
    // The model is prompted, not guaranteed. Nulls, wrong types and missing keys
    // must not throw — they must fail verification with a readable reason.
    const p = toProposal({ insurer: null, detect_patterns: 'not-an-array', labels: [1, 2] });
    expect(p.insurer).toBe('Unknown insurer');
    expect(p.detect_patterns).toEqual([]);
    expect(p.parse_config.labels).toBeUndefined();
  });

  it('drops blank strings rather than storing them as literals', () => {
    const p = toProposal({ detect_patterns: ['ok', '', '   '], section_start: '  ' });
    expect(p.detect_patterns).toEqual(['ok']);
    expect(p.parse_config.sectionStart).toBeUndefined();
  });
});

describe('verifyProposal — accepts a good proposal', () => {
  it('validates the Royal London config against the real pack', () => {
    const result = verifyProposal(ROYAL_LONDON_PACK, GOOD_RL);
    expect(result.usable).toBe(true);
    expect(result.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(result.questions.length).toBeGreaterThan(15);
    expect(result.fingerprint).toHaveLength(64);
  });

  it('validates the MetLife config against the real summary', () => {
    const result = verifyProposal(METLIFE_SUMMARY, GOOD_METLIFE);
    expect(result.usable).toBe(true);
    expect(result.questions.length).toBeGreaterThan(10);
  });

  it('defaults absence_meaningful per question from the measured redaction behaviour', () => {
    const result = verifyProposal(ROYAL_LONDON_PACK, GOOD_RL);
    const smoking = result.questions.find((q) => /smoked, vaped/i.test(q.question));
    const cancer = result.questions.find((q) => /cancer/i.test(q.question));
    // Smoking vocabulary survives redaction, so absence is evidence.
    expect(smoking?.absence_meaningful).toBe(true);
    // Cancer does not, so absence proves nothing and must not be reported as a miss.
    expect(cancer?.absence_meaningful).toBe(false);
  });
});

describe('verifyProposal — rejects bad proposals', () => {
  it('rejects a single detect pattern as too weak', () => {
    const result = verifyProposal(ROYAL_LONDON_PACK, {
      ...GOOD_RL,
      detect_patterns: ['PERSONAL MENU PLAN'],
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /Fewer than two detect patterns/.test(p.message))).toBe(true);
  });

  it('rejects a detect pattern that is not actually in the document', () => {
    // A hallucinated literal would silently never match, so every future sale
    // would fall through to "no document found".
    const result = verifyProposal(ROYAL_LONDON_PACK, {
      ...GOOD_RL,
      detect_patterns: ['PERSONAL MENU PLAN', 'Statement of Demands and Needs'],
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /not present in the document/.test(p.message))).toBe(true);
  });

  it('rejects a wrong answer delimiter', () => {
    const result = verifyProposal(ROYAL_LONDON_PACK, {
      ...GOOD_RL,
      parse_config: { ...ROYAL_LONDON_CONFIG, answerDelimiter: 'Answer:' },
    });
    expect(result.usable).toBe(false);
  });

  it('rejects question_answer with no delimiter at all', () => {
    const result = verifyProposal(ROYAL_LONDON_PACK, {
      ...GOOD_RL,
      parse_config: { sectionStart: 'APPLICATION FORM' },
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /no answer delimiter/.test(p.message))).toBe(true);
  });

  it('rejects label_value with no labels', () => {
    const result = verifyProposal(METLIFE_SUMMARY, {
      ...GOOD_METLIFE,
      parse_config: {},
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /no labels/.test(p.message))).toBe(true);
  });

  it('rejects a config whose section boundaries leak the commission schedule', () => {
    // The most important check. Losing the boundary pulls the firm's own
    // earnings and the underwriting decision into the compliance record.
    const leaky = [
      'Question one?',
      'Your answer(s):',
      'Yes',
      '',
      "We'll pay the firm the commission shown below.",
      'Year 1: £1,158.26',
      'Question two?',
      'Your answer(s):',
      'No',
      '',
    ].join('\n');
    const result = verifyProposal(leaky, {
      ...GOOD_RL,
      detect_patterns: ['Question one', 'Your answer(s):'],
      parse_config: { answerDelimiter: 'Your answer(s):' },
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /section boundaries/.test(p.message))).toBe(true);
  });

  it('accepts the Royal London config precisely because its boundaries hold', () => {
    // The counterpart to the test above: with sectionEnd in place, the quote and
    // commission schedule that follow the application never reach the output.
    const result = verifyProposal(ROYAL_LONDON_PACK, GOOD_RL);
    expect(JSON.stringify(result.parsed.pairs)).not.toMatch(/commission|1,158\.26/i);
    expect(result.usable).toBe(true);
  });

  it('rejects a config that parses every question as unanswered', () => {
    const result = verifyProposal(
      'Question one?\nYour answer(s):\n\nQuestion two?\nYour answer(s):\n',
      { ...GOOD_RL, detect_patterns: ['Question one', 'Your answer(s):'], parse_config: { answerDelimiter: 'Your answer(s):' } }
    );
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /every question parsed with no answer/i.test(p.message))).toBe(true);
  });

  it('warns rather than fails when a summary sheet was read as question_answer', () => {
    const result = verifyProposal(
      'Some doc\nOne question?\nYour answer(s):\nYes\n',
      {
        ...GOOD_RL,
        detect_patterns: ['Some doc', 'Your answer(s):'],
        parse_config: { answerDelimiter: 'Your answer(s):' },
      }
    );
    expect(result.problems.some((p) => p.severity === 'warning' && /label_value is likely/.test(p.message))).toBe(true);
  });
});

describe('question_marker proposals', () => {
  // The portal export is the format on every fully-underwritten sale sampled so
  // far, and until now the learner could not produce it at all: the tool schema
  // did not offer the strategy, toProposal coerced it to question_answer, and the
  // migration's CHECK would have rejected the row. Cover the whole path.
  const GOOD_PORTAL: ProfileProposal = {
    insurer: 'Sample Insurer',
    product: null,
    strategy: 'question_marker',
    detect_patterns: ['The information you have provided', 'Please tell us some things about yourself'],
    parse_config: PORTAL_CONFIG,
    notes: null,
  };

  it('maps a question_marker tool payload without coercing the strategy', () => {
    const p = toProposal({
      insurer: 'Sample Insurer',
      strategy: 'question_marker',
      detect_patterns: ['The information you have provided'],
      question_marker: 'Q',
      options_prefix: 'Options - ',
      answer_line_pattern: String.raw`^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}) - (.*?)(?: \(([^()]*)\))?$`,
    });
    expect(p.strategy).toBe('question_marker');
    expect(p.parse_config.questionMarker).toBe('Q');
    expect(p.parse_config.optionsPrefix).toBe('Options - ');
    expect(p.parse_config.answerLinePattern).toContain('\\d{2}');
  });

  it('accepts a config that actually reads the portal export', () => {
    const result = verifyProposal(PORTAL_EXPORT, GOOD_PORTAL);
    expect(result.usable).toBe(true);
    expect(result.questions.length).toBeGreaterThan(3);
  });

  it('rejects question_marker with no question marker', () => {
    const result = verifyProposal(PORTAL_EXPORT, {
      ...GOOD_PORTAL,
      parse_config: { optionsPrefix: 'Options - ' },
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /no question marker/i.test(p.message))).toBe(true);
  });

  it('rejects an answer pattern that cannot give the parser its three groups', () => {
    // A pattern with too few groups leaves the parser seeing no answers, and
    // every question would then read as unanswered — indistinguishable from an
    // adviser skipping the whole application.
    const result = verifyProposal(PORTAL_EXPORT, {
      ...GOOD_PORTAL,
      parse_config: { ...PORTAL_CONFIG, answerLinePattern: String.raw`^(\d+) - (.*)$` },
    });
    expect(result.usable).toBe(false);
    expect(result.problems.some((p) => /three capture groups/i.test(p.message))).toBe(true);
  });

  it('allows the answer pattern to be omitted, since the parser has a default', () => {
    const result = verifyProposal(PORTAL_EXPORT, GOOD_PORTAL);
    expect(result.problems.some((p) => /answer line pattern/i.test(p.message))).toBe(false);
  });
});

describe('isUsableAnswerPattern', () => {
  it('accepts the parser default', () => {
    expect(
      isUsableAnswerPattern(String.raw`^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}) - (.*?)(?: \(([^()]*)\))?$`)
    ).toBe(true);
  });

  it('counts an optional group, which the default relies on', () => {
    expect(isUsableAnswerPattern('(a)(b)(c)?')).toBe(true);
  });

  it('rejects too few groups', () => {
    expect(isUsableAnswerPattern('(a)(b)')).toBe(false);
  });

  it('rejects a pattern that does not compile', () => {
    expect(isUsableAnswerPattern('(unclosed')).toBe(false);
  });

  it('does not count a non-capturing group', () => {
    expect(isUsableAnswerPattern('(?:a)(b)(c)')).toBe(false);
  });
});

describe('sampleForLearning', () => {
  it('passes a short document through untouched', () => {
    expect(sampleForLearning('short doc')).toBe('short doc');
  });

  it('keeps the head and the tail, where the boundaries live', () => {
    const doc = 'A'.repeat(9000) + 'MIDDLE'.repeat(3000) + 'Z'.repeat(3000);
    const sample = sampleForLearning(doc);
    expect(sample.length).toBeLessThan(doc.length);
    expect(sample.startsWith('A')).toBe(true);
    expect(sample.endsWith('Z')).toBe(true);
    expect(sample).toContain('truncated for analysis');
  });
});

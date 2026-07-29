import { describe, it, expect } from 'vitest';
import { analyseCheckpoint, analyseScorecard } from './checkpoint-quality.js';

// Fixtures are real Trust Point checkpoints, labelled by what repeated scoring
// of real sales actually showed. The point of these tests is not that the
// regexes fire — it is that they do not fire on wording measured to be stable.
// A warning that sends a tenant off to rewrite a checkpoint that was never a
// problem costs more than the warning is worth.

describe('analyseCheckpoint', () => {
  it('flags an absolute that makes one exception a failure', () => {
    const issues = analyseCheckpoint({
      label: 'Allowed the customer to answer every H&L question',
      description: 'Did the adviser allow the customer to answer every Health & Lifestyle question themselves?',
    });
    expect(issues.map((i) => i.kind)).toContain('absolute');
    expect(issues.find((i) => i.kind === 'absolute')?.found.toLowerCase()).toBe('every');
  });

  it('flags a conditional with no stated decider', () => {
    const issues = analyseCheckpoint({
      label: 'Mentioned policy can be placed in Trust free of charge',
      description: 'Did the adviser mention the policy can be put into Trust free of charge where applicable?',
    });
    expect(issues.map((i) => i.kind)).toContain('conditional');
  });

  it('flags a threshold word with no threshold', () => {
    const issues = analyseCheckpoint({
      label: 'Clearly stated the application outcome',
      description: 'Did the adviser clearly state the application outcome?',
    });
    expect(issues.map((i) => i.kind)).toContain('subjective');
  });

  // The regression that matters. This checkpoint reads as compound and scored
  // identically on every run of every sale; an earlier clause-counting detector
  // flagged it and 12 others like it, at 19% precision against a 39% base rate.
  it('does NOT flag a scripted phrase that happens to contain "and"', () => {
    expect(
      analyseCheckpoint({
        label: 'Stated Trust Point is authorised and regulated by the FCA',
        description: 'Did the adviser state that Trust Point is authorised and regulated by the Financial Conduct Authority?',
      })
    ).toEqual([]);
  });

  it('does NOT flag other checkpoints measured as stable', () => {
    const stable = [
      { label: 'Gave the call-recording disclosure', description: 'Did the adviser disclose that the call is recorded?' },
      { label: 'Sought consent for the insurer to contact the GP', description: 'Did the adviser seek consent for the insurer to contact the GP?' },
      { label: 'Set up the Direct Debit and confirmed start & payment dates', description: 'Did the adviser set up the Direct Debit and confirm the start and payment dates?' },
      { label: 'Made the friends & family referral ask', description: 'Did the adviser ask whether anyone else might benefit from a protection review?' },
    ];
    for (const item of stable) {
      expect(analyseCheckpoint(item), `should not flag: ${item.label}`).toEqual([]);
    }
  });

  it('reads the description rather than the label, since that is the rubric the model receives', () => {
    // Innocuous label, problem wording in the rubric.
    const issues = analyseCheckpoint({
      label: 'Outcome',
      description: 'Did the adviser clearly state the outcome?',
    });
    expect(issues.map((i) => i.kind)).toEqual(['subjective']);
  });

  it('falls back to the label when there is no description', () => {
    expect(analyseCheckpoint({ label: 'Answered every question' }).map((i) => i.kind)).toEqual(['absolute']);
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(analyseCheckpoint({ label: '', description: null })).toEqual([]);
    expect(analyseCheckpoint({ label: '   ', description: '  ' })).toEqual([]);
  });
});

describe('analyseScorecard', () => {
  it('returns only the checkpoints with issues, worst first', () => {
    const warnings = analyseScorecard([
      { sort_order: 0, label: 'Fine', description: 'Did the adviser state the policy number?' },
      { sort_order: 1, label: 'One issue', description: 'Did the adviser answer every question?' },
      { sort_order: 2, label: 'Two issues', description: 'Did the adviser clearly explain every benefit?' },
    ]);
    expect(warnings.map((w) => w.sort_order)).toEqual([2, 1]);
    expect(warnings[0]!.issues).toHaveLength(2);
  });

  it('returns nothing for a scorecard with no risky wording', () => {
    expect(
      analyseScorecard([{ sort_order: 0, label: 'Ok', description: 'Did the adviser state the premium?' }])
    ).toEqual([]);
  });
});

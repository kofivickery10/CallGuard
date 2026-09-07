import { describe, it, expect } from 'vitest';
import { renderFeedbackEmail } from './feedback-email.js';

// The email now carries a client's name next to compliance findings drawn from a
// call that may contain health disclosures. These tests pin the two properties
// that matter for that: what is allowed in (the finding and its reason) and what
// must stay out (anything quoted from the call).

const base = {
  adviserName: 'Danni Beck',
  confirmUrl: 'https://app.example.test/feedback/tok',
  message: null,
  clientName: 'James Whitfield',
  score: 77.77777,
  items: [
    {
      label: 'Obtained clear affirmative consent to the recommendation',
      severity: 'high',
      reasoning: 'The adviser moved on to payment without the customer agreeing.',
    },
  ],
};

describe('renderFeedbackEmail', () => {
  it('keeps the client out of the subject, which renders on a lock screen', () => {
    const { subject, html } = renderFeedbackEmail(base);
    expect(subject).not.toContain('James Whitfield');
    // Named in the body instead, so the adviser can still tell two sales apart.
    expect(html).toContain('James Whitfield');
  });

  it('uses the same subject whether or not the sale has a client name', () => {
    // The property, not a literal: a subject that varies with the client is a
    // subject that leaks one.
    expect(renderFeedbackEmail(base).subject).toBe(
      renderFeedbackEmail({ ...base, clientName: null }).subject
    );
  });

  it('states the verdict, because a percentage alone can flatter a failed sale', () => {
    // callPasses() fails a sale on any critical breach regardless of the number,
    // so "77.8%" on its own can tell an adviser they did fine on a sale that did
    // not pass.
    const failed = renderFeedbackEmail({ ...base, pass: false });
    expect(failed.html).toContain('Fail');
    expect(failed.text).toContain('Fail');

    const passed = renderFeedbackEmail({ ...base, pass: true });
    expect(passed.html).toContain('Pass');
    expect(passed.text).toContain('Pass');
  });

  it('states no verdict when the sale has none, and none under score_only', () => {
    // null = the sale has no verdict; absent = score_only, where the key never
    // enters the payload. Both must render nothing rather than "Fail".
    for (const data of [{ ...base, pass: null }, base]) {
      const { html, text } = renderFeedbackEmail(data);
      expect(html).not.toContain('>Fail<');
      expect(text).not.toMatch(/ - (Pass|Fail)$/m);
    }
  });

  it('says where the detail went when reasoning was withheld, rather than dropping it', () => {
    // DPIA R5: for a tenant that keeps health unredacted the reasons stay behind
    // the link. A silently shorter email is indistinguishable from a complete
    // one, so the email has to say so.
    const { html, text } = renderFeedbackEmail({
      ...base,
      reasoningWithheld: true,
      items: [{ label: 'Obtained clear affirmative consent', severity: 'high' }],
    });
    expect(html).toContain('is in CallGuard rather than this email');
    expect(text).toContain('is in CallGuard rather than this email');
    expect(html).toContain('Obtained clear affirmative consent');
  });

  it('renders no score for a non-numeric value rather than "NaN%"', () => {
    // overall_score is NUMERIC(5,2) and arrives from pg as a string, so the
    // guard has to coerce — Number.isNaN would pass "abc" straight through.
    const { html, text } = renderFeedbackEmail({
      ...base,
      score: 'abc' as unknown as number,
    });
    expect(html).not.toContain('NaN');
    expect(text).not.toContain('NaN');
    expect(html).not.toContain('scored');
  });

  it('reads a numeric string score, which is what pg actually returns', () => {
    const { html } = renderFeedbackEmail({ ...base, score: '77.77777' as unknown as number });
    expect(html).toContain('77.8%');
  });

  it('states the score to one decimal place, in both parts', () => {
    const { html, text } = renderFeedbackEmail(base);
    expect(html).toContain('77.8%');
    expect(text).toContain('scored 77.8%');
  });

  it('says nothing about a score the sale does not have, rather than 0%', () => {
    // A sale held at nothingAutoScored has findings but no number. Printing 0%
    // would be a claim about an adviser that nobody has made.
    const { html, text } = renderFeedbackEmail({ ...base, score: null });
    // Assert on the score rendering itself, not on '%' or a bare number — the
    // inline CSS is full of both (width: 100%, font-size: 14px).
    expect(html).not.toContain('scored');
    expect(html).not.toContain('77.8');
    expect(text).not.toContain('scored');
    expect(text).not.toContain('77.8');
    // The sale is still identified; only the number is withheld.
    expect(html).toContain('James Whitfield');
  });

  it('gives the reason under each finding, in both parts', () => {
    const { html, text } = renderFeedbackEmail(base);
    expect(html).toContain('The adviser moved on to payment without the customer agreeing.');
    expect(text).toContain('The adviser moved on to payment without the customer agreeing.');
  });

  it('still renders a finding that has no reason', () => {
    const { html, text } = renderFeedbackEmail({
      ...base,
      items: [{ label: 'Asked for a Google review', severity: 'low', reasoning: null }],
    });
    expect(html).toContain('Asked for a Google review');
    expect(text).toContain('Asked for a Google review');
    expect(text).not.toContain('null');
  });

  it('escapes a client name that contains markup', () => {
    const { html } = renderFeedbackEmail({ ...base, clientName: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a reason that contains markup', () => {
    const { html } = renderFeedbackEmail({
      ...base,
      items: [{ label: 'A checkpoint', severity: 'low', reasoning: '<img src=x onerror=1>' }],
    });
    expect(html).not.toContain('<img');
  });

  it('carries no transcript quote, because the caller never sends one', () => {
    // The guard is in the type: FeedbackEmailJob has no evidence field, so a
    // future caller cannot pass one without this failing to compile. This asserts
    // the rendered output likewise never invents one.
    const { html, text } = renderFeedbackEmail(base);
    expect(html).not.toMatch(/evidence/i);
    expect(text).not.toMatch(/evidence/i);
  });

  it('tells an adviser with nothing outstanding that nothing was flagged', () => {
    const { html, text } = renderFeedbackEmail({ ...base, items: [] });
    expect(html).toContain('Nothing was flagged against you');
    expect(text).toContain('Nothing was flagged against you');
  });
});

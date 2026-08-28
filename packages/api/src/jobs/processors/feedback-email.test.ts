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
  it('names the sale in the subject so two sales can be told apart', () => {
    expect(renderFeedbackEmail(base).subject).toBe(
      '[CallGuard] Feedback on your sale for James Whitfield'
    );
  });

  it('falls back to a generic subject when the sale has no client name', () => {
    const { subject } = renderFeedbackEmail({ ...base, clientName: null });
    expect(subject).toBe('[CallGuard] Feedback on a reviewed sale');
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

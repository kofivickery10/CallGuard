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

  it('sends a recipient who CAN see the detail to CallGuard', () => {
    // DPIA R5: for a tenant that keeps health unredacted the reasons stay behind
    // the link. A silently shorter email is indistinguishable from a complete
    // one, so the email has to say so.
    const { html, text } = renderFeedbackEmail({
      ...base,
      reasoningWithheld: true,
      recipientCanSeeDetail: true,
      items: [{ label: 'Obtained clear affirmative consent', severity: 'high' }],
    });
    expect(html).toContain("The AI's reason for each point is in CallGuard");
    expect(text).toContain("The AI's reason for each point is in CallGuard");
    expect(html).toContain('Obtained clear affirmative consent');
  });

  // The case that made this a branch, and it is wider than "no login".
  // Advisers commonly have none at all (061) and Trust Point's have none. But
  // an adviser-role user WITH a working password sees no reasoning either:
  // every surface serving it sits behind requireOrgView, and ORG_WIDE_ROLES
  // excludes advisers, while calls.ts — the one adviser-scoped surface —
  // selects reasoning nowhere. The confirm link is no answer either: that page
  // shows a name and a button, never the findings. So the email must not send
  // any of them to the platform.
  it('points a recipient who cannot see the detail at their supervisor', () => {
    const { html, text } = renderFeedbackEmail({
      ...base,
      reasoningWithheld: true,
      recipientCanSeeDetail: false,
      items: [{ label: 'Obtained clear affirmative consent', severity: 'high' }],
    });
    for (const part of [html, text]) {
      expect(part).toContain('not in this email');
      expect(part).toContain('supervisor');
      // The promise that could not be kept.
      expect(part).not.toContain('is in CallGuard rather than this email');
      expect(part).not.toContain('Sign in to CallGuard');
    }
    expect(html).toContain('Obtained clear affirmative consent');
  });

  // Absent must read as "cannot sign in": that branch sends the reader to a
  // person rather than to a page they may not be able to open, so it is the
  // safe default for a payload written before this field existed — a job can
  // sit in Redis across the deploy that introduces it.
  it('treats a missing recipientCanSeeDetail as cannot see it', () => {
    const { html } = renderFeedbackEmail({
      ...base,
      reasoningWithheld: true,
      items: [{ label: 'Obtained clear affirmative consent', severity: 'high' }],
    });
    expect(html).toContain('supervisor');
    expect(html).not.toContain('is in CallGuard rather than this email');
  });

  // Nothing was withheld, so neither sentence belongs — the adviser has the
  // reasons in front of them.
  it('says nothing about withheld detail when nothing was withheld', () => {
    const { html, text } = renderFeedbackEmail({
      ...base,
      recipientCanSeeDetail: false,
      items: [{ label: 'Obtained clear affirmative consent', severity: 'high', reasoning: 'The adviser did not ask.' }],
    });
    for (const part of [html, text]) {
      expect(part).not.toContain('not in this email');
      expect(part).not.toContain('is in CallGuard rather than this email');
    }
    expect(html).toContain('The adviser did not ask.');
  });

  // ── Remediation guidance (CG-24) ──────────────────────────────────────────

  it('renders guidance under its checkpoint, labelled, in both parts', () => {
    const { html, text } = renderFeedbackEmail({
      ...base,
      items: [
        {
          label: 'Explained the pre-existing conditions exclusion',
          severity: 'high',
          reasoning: 'The adviser did not mention the exclusion.',
          remediationGuidance: 'Call the customer back and confirm the exclusion applies.',
        },
      ],
    });
    for (const part of [html, text]) {
      expect(part).toContain('What to do:');
      expect(part).toContain('Call the customer back and confirm the exclusion applies.');
      // Both lines present, and distinguishable: the reason is why it was
      // flagged, the guidance is what to do about it.
      expect(part).toContain('The adviser did not mention the exclusion.');
    }
  });

  // The decision this phase turns on. `includeReasoning` is false on a tenant
  // that keeps health unredacted, because the MODEL's sentence is derived from
  // the call. Guidance is not: the firm wrote it in advance against the
  // criterion, without seeing any customer, so the rule that withholds
  // reasoning has nothing to say about it. On exactly those tenants it is the
  // only actionable content the adviser gets.
  it('still sends guidance when the model reasoning was withheld', () => {
    const { html, text } = renderFeedbackEmail({
      ...base,
      reasoningWithheld: true,
      recipientCanSeeDetail: false,
      items: [
        {
          label: 'Explained the pre-existing conditions exclusion',
          severity: 'high',
          remediationGuidance: 'Call the customer back and confirm the exclusion applies.',
        },
      ],
    });
    for (const part of [html, text]) {
      expect(part).toContain('Call the customer back and confirm the exclusion applies.');
      // The withheld note still fires, and names the reason specifically — it
      // sits directly under a visible "What to do" line, so "the detail" would
      // read as though the guidance had been withheld too.
      expect(part).toContain("The AI's reason for each point is not in this email");
    }
  });

  it('says nothing about guidance on a checkpoint that has none', () => {
    const { html, text } = renderFeedbackEmail({
      ...base,
      items: [{ label: 'Obtained clear affirmative consent', severity: 'high' }],
    });
    for (const part of [html, text]) {
      expect(part).not.toContain('What to do:');
    }
  });

  it('escapes guidance, which is firm-authored free text', () => {
    const { html } = renderFeedbackEmail({
      ...base,
      items: [
        {
          label: 'A checkpoint',
          severity: 'low',
          remediationGuidance: '<script>alert(1)</script> Ring & confirm',
        },
      ],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('renders guidance with no reason, and still closes the row', () => {
    // A finding can carry guidance without a reason — on a withholding tenant,
    // or where the model gave none. The separator must not go missing.
    const { html } = renderFeedbackEmail({
      ...base,
      items: [{ label: 'A checkpoint', severity: 'low', remediationGuidance: 'Do the thing.' }],
    });
    expect(html).toContain('Do the thing.');
    expect(html).toContain('border-bottom: 1px solid #e2e8e2;');
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

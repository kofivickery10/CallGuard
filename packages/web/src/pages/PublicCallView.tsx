import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { PublicCallView as PublicCallViewData } from '@callguard/shared';

export function PublicCallView() {
  const { token } = useParams<{ token: string }>();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['public-share', token],
    queryFn: async () => {
      const res = await fetch(`/api/public/shared-calls/${token}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message || 'Failed to load');
      }
      return res.json() as Promise<PublicCallViewData>;
    },
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center text-text-muted">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-page flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-[22px] font-semibold text-text-primary mb-2">Link Unavailable</div>
          <p className="text-table-cell text-text-subtle">{(error as Error).message}</p>
          <p className="text-[12px] text-text-muted mt-4">This link may have expired or been revoked.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-page flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-border py-4 px-6">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="none">
              <rect x="4.5"  y="14"   width="2.4" height="4"  rx="1.1" fill="white"/>
              <rect x="9"    y="11"   width="2.4" height="7"  rx="1.1" fill="white"/>
              <rect x="13.5" y="8"    width="2.4" height="10" rx="1.1" fill="white"/>
              <circle cx="19" cy="6"  r="1.6" fill="white"/>
            </svg>
          </div>
          <span className="text-[17px] font-bold text-text-primary tracking-tight">CallGuard <span className="text-primary">AI</span></span>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-3xl mx-auto w-full p-8">
        <div className="mb-6">
          <div className="text-[12px] uppercase tracking-wider text-text-muted">{data.organization_name}</div>
          <h1 className="text-page-title text-text-primary mt-1">Call Quality Summary</h1>
          <p className="text-page-sub text-text-subtle mt-1">
            {data.file_name}
            {data.duration_seconds && ` · ${Math.floor(data.duration_seconds / 60)}:${String(Math.floor(data.duration_seconds % 60)).padStart(2, '0')}`}
            {data.call_date && ` · ${new Date(data.call_date).toLocaleDateString('en-GB')}`}
          </p>
        </div>

        {/* Score card */}
        <div className="bg-white border border-border rounded-card p-6 mb-6 flex items-center justify-between">
          <div>
            <div className="text-[12px] uppercase tracking-wider text-text-muted mb-1">Overall Score</div>
            <div className="flex items-baseline gap-3">
              {data.overall_score != null ? (
                <>
                  <span className={`text-[48px] font-bold font-mono ${scoreColor(data.overall_score)}`}>
                    {Math.round(data.overall_score)}%
                  </span>
                  <span className={`px-3 py-1 rounded-[20px] text-[12px] font-semibold uppercase ${
                    data.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
                  }`}>
                    {data.pass ? 'Pass' : 'Needs Review'}
                  </span>
                </>
              ) : (
                <span className="text-text-muted">Not yet scored</span>
              )}
            </div>
          </div>
        </div>

        {/* Scorecard items */}
        {data.items.length > 0 && (
          <div className="bg-white border border-border rounded-card overflow-hidden mb-6">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-[15px] font-semibold text-text-primary">Quality Criteria</h3>
            </div>
            {data.items.map((item, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-5 py-3 border-b border-border-light last:border-0"
              >
                <span className="text-table-cell text-text-cell flex-1 pr-4">{item.label}</span>
                <span
                  className={`px-2.5 py-[3px] rounded-[20px] text-[11px] font-semibold ${
                    item.passed ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
                  }`}
                >
                  {item.passed ? 'Pass' : 'Review'}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Feedback form */}
        {!data.feedback_submitted ? (
          <FeedbackForm token={token!} onSubmitted={() => refetch()} />
        ) : (
          <div className="bg-pass-bg border border-pass/20 text-pass rounded-card p-5 text-center">
            Thank you for your feedback - it has been recorded.
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="text-center py-6 text-[12px] text-text-muted">
        Powered by CallGuard · Secure AI Call QA
      </footer>
    </div>
  );
}

function FeedbackForm({ token, onSubmitted }: { token: string; onSubmitted: () => void }) {
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (stars === 0) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/public/shared-calls/${token}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stars, comment: comment || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message || 'Failed to submit');
      }
      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white border border-border rounded-card p-5">
      <h3 className="text-[15px] font-semibold text-text-primary mb-1">Your Feedback (optional)</h3>
      <p className="text-table-cell text-text-subtle mb-4">
        How satisfied were you with your call? Your feedback helps improve our service.
      </p>

      {error && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>
      )}

      <div className="flex gap-1 mb-4">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setStars(n)}
            className={`w-10 h-10 text-[28px] transition-colors ${
              n <= stars ? 'text-secondary' : 'text-border'
            }`}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
          >
            ★
          </button>
        ))}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Any comments? (optional)"
        rows={3}
        maxLength={2000}
        className="w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
      />

      <button
        onClick={submit}
        disabled={stars === 0 || submitting}
        className="mt-4 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors"
      >
        {submitting ? 'Submitting...' : 'Submit Feedback'}
      </button>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-pass';
  if (score >= 65) return 'text-review';
  return 'text-fail';
}

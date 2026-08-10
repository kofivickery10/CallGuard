import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

// The adviser's landing page from the email: it checks the link (GET) and then
// asks for a deliberate click to confirm (POST) — a page load alone must never
// record an acknowledgment, since mail-security gateways routinely prefetch
// links in emails.
//
// UNAUTHENTICATED and outside the app shell on purpose: the recipient may have no
// login at all (no-login advisers), so anything requiring a session would make
// the link useless to exactly the people it exists for. It also means no nav, no
// org data, and nothing here that a stranger with a guessed URL could learn
// beyond the adviser's own name and how many findings are waiting — never the
// sale, the customer, or what any finding is about.

type Status = 'loading' | 'pending' | 'confirmed' | 'already_confirmed' | 'expired' | 'not_found' | 'error';

interface ConfirmResponse {
  status: 'pending' | 'confirmed' | 'already_confirmed' | 'expired' | 'not_found';
  adviserName?: string;
  itemCount?: number;
}

function TickIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.8" aria-hidden="true">
      <path
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FeedbackConfirm() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [name, setName] = useState<string | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`/api/feedback/${token}`);
        if (!res.ok) throw new Error(String(res.status));
        const data: ConfirmResponse = await res.json();
        if (cancelled) return;
        setName(data.adviserName ?? null);
        setItemCount(data.itemCount ?? null);
        setStatus(data.status);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  // The adviser's deliberate click. Kept separate from the GET on mount so that
  // a mail-security gateway prefetching the emailed link — which only ever
  // loads the page — can never confirm anything on the adviser's behalf.
  const handleConfirm = async () => {
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/feedback/${token}/confirm`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const data: ConfirmResponse = await res.json();
      setName(data.adviserName ?? null);
      setItemCount(data.itemCount ?? null);
      setStatus(data.status);
    } catch {
      // Stay on the 'pending' branch and offer a retry inline, rather than
      // dropping to the full-page 'error' branch — the link itself is fine,
      // only the confirm attempt failed, and the button should stay usable.
      setConfirmError("We couldn't record that just now. Please try again.");
    } finally {
      setConfirming(false);
    }
  };

  const content = () => {
    switch (status) {
      case 'loading':
        return (
          <div className="flex items-center justify-center gap-3 text-text-muted text-table-cell py-4">
            <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
            Checking this link…
          </div>
        );
      case 'pending':
        return (
          <div className="text-center">
            <InfoIcon className="w-12 h-12 text-text-muted mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">Feedback on a reviewed sale</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              {name ? `${name}, your` : 'Your'} supervisor has reviewed a sale and would like you to
              confirm you have seen the feedback
              {typeof itemCount === 'number'
                ? ` on ${itemCount} ${itemCount === 1 ? 'finding' : 'findings'}`
                : ''}
              .
            </p>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              aria-label="Confirm I have seen this feedback"
              className="mt-4 px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {confirming ? 'Confirming…' : 'Confirm I have seen this'}
            </button>
            {confirmError && (
              <p className="text-table-cell text-fail mt-3" role="alert">
                {confirmError}
              </p>
            )}
          </div>
        );
      case 'confirmed':
      case 'already_confirmed':
        return (
          <div className="text-center">
            <TickIcon className="w-12 h-12 text-pass mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">
              {status === 'confirmed' ? 'Thank you' : 'Already confirmed'}
            </h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              {status === 'confirmed'
                ? `We have recorded that you${name ? `, ${name},` : ''} received this feedback.`
                : 'You have already confirmed this feedback. Nothing more is needed.'}
            </p>
            <p className="text-xs text-text-muted mt-4">You can close this page.</p>
          </div>
        );
      case 'expired':
        return (
          <div className="text-center">
            <InfoIcon className="w-12 h-12 text-review mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">This link has expired</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              Confirmation links are valid for 30 days. Ask your supervisor to send it again.
            </p>
          </div>
        );
      case 'error':
        // A transport failure (network error, non-2xx, rate limit) — NOT the
        // same thing as 'not_found'. Blaming the token for a fetch failure is
        // exactly the bug this page used to hide: don't leak the status code
        // or any server message here, just offer a retry.
        return (
          <div className="text-center">
            <AlertIcon className="w-12 h-12 text-fail mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">We couldn&apos;t check this link</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              Something went wrong on our end. The link itself is probably fine — please try again in
              a moment.
            </p>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              aria-label="Try checking this link again"
              className="mt-4 px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Try again
            </button>
          </div>
        );
      default:
        // 'not_found' lands here. Not merging it with a real network/HTTP
        // failure ('error', handled above) is deliberate probing-resistance:
        // an unknown token and a mistyped/reused one must look identical, so
        // someone guessing URLs can't learn which tokens exist from the copy.
        return (
          <div className="text-center">
            <InfoIcon className="w-12 h-12 text-text-muted mx-auto" />
            <h1 className="text-page-title text-text-primary mt-4">This link is not valid</h1>
            <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
              It may have been mistyped or replaced by a newer one. Ask your supervisor to send it
              again.
            </p>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-card px-6 py-8">{content()}</div>
        <p className="text-center text-xs text-text-muted mt-4">CallGuard</p>
      </div>
    </div>
  );
}

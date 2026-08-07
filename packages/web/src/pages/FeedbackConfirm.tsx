import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

// The adviser's one click, landed on from the email.
//
// UNAUTHENTICATED and outside the app shell on purpose: the recipient may have no
// login at all (no-login advisers), so anything requiring a session would make
// the link useless to exactly the people it exists for. It also means no nav, no
// org data, and nothing here that a stranger with a guessed URL could learn —
// the page never names the sale or the findings.

type Status = 'loading' | 'confirmed' | 'already_confirmed' | 'expired' | 'not_found' | 'error';

interface ConfirmResponse {
  status: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found';
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

export function FeedbackConfirm() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/feedback/${token}`);
        if (!res.ok) throw new Error(String(res.status));
        const data: ConfirmResponse = await res.json();
        if (cancelled) return;
        setName(data.adviserName ?? null);
        setStatus(data.status);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const content = () => {
    switch (status) {
      case 'loading':
        return (
          <div className="flex items-center justify-center gap-3 text-text-muted text-table-cell py-4">
            <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
            Confirming…
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
      default:
        // 'not_found' and 'error' land here together and say the same thing.
        // Distinguishing them would tell someone probing URLs which tokens are
        // real, and neither case is actionable by the person reading it.
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

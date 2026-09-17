import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { SaleArrivalStatus } from '@callguard/shared';

// Tells a firm that scores sales when sales have stopped reaching CallGuard.
//
// A sales_only firm scores nothing until a sale arrives. If its CRM webhook
// breaks, or nobody presses "Score sale", calls keep coming in unscored, and
// there used to be nothing on screen to say so. The API decides when that
// needs saying (services/sale-arrival.ts: calls came in over the last week, and
// no sale did); this only words it. Every sentence has to stay true under that
// rule: it speaks about calls received in the window, never about how long
// older unsold calls have waited, because most calls never become sales.
//
// Admins and supervisors only, matching the endpoint: they can act on it.
//
// Loading and error render nothing, deliberately. This is advice about the
// list below, not the list itself: a failed check must not put an error above
// a page that loaded fine, and a banner flashing in while the check runs would
// be noise on every visit for the firms it never applies to.
export function SaleArrivalBanner({ enabled }: { enabled: boolean }) {
  const { data } = useQuery({
    queryKey: ['organization', 'sale-arrival'],
    queryFn: () => api.get<SaleArrivalStatus>('/organization/sale-arrival'),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

  if (!enabled || !data?.needs_attention || !data.oldest_waiting_at) return null;

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const count = data.waiting_calls;
  const days = data.attention_after_days;
  const first = formatDate(data.oldest_waiting_at);
  const received =
    count === 1
      ? `1 call has come in over the last ${days} days, on ${first}, and it is not part of a sale yet.`
      : `${count} calls have come in over the last ${days} days, the first on ${first}, and none of them is part of a sale yet.`;
  const lastSale = data.last_sale_at
    ? `The last sale arrived on ${formatDate(data.last_sale_at)}.`
    : 'No sale has arrived yet.';

  return (
    <section
      aria-labelledby="sale-arrival-title"
      className="bg-review-bg border-l-[3px] border-l-review rounded-card p-4 mb-5"
    >
      <div className="flex items-start gap-2.5">
        <svg
          className="w-4 h-4 text-review shrink-0 mt-0.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15 14" />
        </svg>
        <div className="min-w-0">
          <h3 id="sale-arrival-title" className="text-table-cell font-semibold text-text-primary mb-1">
            No sales have arrived in the last {days} days
          </h3>
          <p className="text-table-cell text-text-secondary">
            Your firm is set to score sales, so a call is only scored once a sale for that customer
            reaches CallGuard. {received} {lastSale}
          </p>
          <p className="text-table-cell text-text-secondary mt-1">
            To score {count === 1 ? 'it' : 'them'}, send the sale from your CRM, or open the customer
            and use Score sale.{' '}
            <Link
              to="/customers"
              className="text-primary font-semibold hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Go to customers
            </Link>
            . If your firm would rather score every call on its own, ask CallGuard to switch it to
            scoring calls.
          </p>
        </div>
      </div>
    </section>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Scorecard } from '@callguard/shared';

function ScorecardCardSkeleton() {
  const shimmer =
    'h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer';
  const shimmerStyle = {
    backgroundImage:
      'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
  };
  return (
    <div className="bg-card border border-border rounded-card p-5">
      <div className={`${shimmer} mb-2.5`} style={{ ...shimmerStyle, width: '60%' }} />
      <div className={shimmer} style={{ ...shimmerStyle, width: '90%' }} />
    </div>
  );
}

export function Scorecards() {
  const { data, isLoading, isError, isRefetching, refetch } = useQuery({
    queryKey: ['scorecards'],
    queryFn: () => api.get<{ data: Scorecard[] }>('/scorecards'),
  });

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Scorecards</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Define the criteria for evaluating your calls
        </p>
      </div>

      {isError ? (
        <div role="alert" className="bg-fail-bg text-fail px-4 py-3 rounded-btn text-table-cell inline-flex items-center gap-3">
          Could not load scorecards.
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="underline font-semibold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {isRefetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <ScorecardCardSkeleton key={`skeleton-${i}`} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.data.map((scorecard) => (
            <Link
              key={scorecard.id}
              to={`/scorecards/${scorecard.id}/edit`}
              className="bg-card border border-border rounded-card p-5 cursor-pointer transition-all hover:border-primary hover:shadow-md group"
            >
              <h3 className="text-sm font-semibold text-text-primary mb-1.5">
                {scorecard.name}
              </h3>
              {scorecard.description && (
                <p className="text-xs text-text-subtle leading-relaxed">
                  {scorecard.description}
                </p>
              )}
              <div className="mt-3 text-xs text-primary-ink font-semibold">
                {scorecard.is_active ? 'Active' : 'Inactive'}
              </div>
            </Link>
          ))}

          {/* Create new card */}
          <Link
            to="/scorecards/new"
            className="border-2 border-dashed border-border rounded-card p-5 flex flex-col items-center justify-center text-text-muted cursor-pointer transition-all hover:text-primary-ink hover:border-primary min-h-[120px]"
          >
            <span className="text-[28px] font-light leading-none mb-1">+</span>
            <span className="text-xs font-medium">Create New Scorecard</span>
          </Link>
        </div>
      )}
    </div>
  );
}

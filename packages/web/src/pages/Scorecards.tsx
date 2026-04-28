import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Scorecard } from '@callguard/shared';

export function Scorecards() {
  const { data, isLoading } = useQuery({
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

      {isLoading ? (
        <div className="text-text-muted text-table-cell">Loading...</div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {data?.data.map((scorecard) => (
            <Link
              key={scorecard.id}
              to={`/scorecards/${scorecard.id}/edit`}
              className="bg-white border border-border rounded-card p-5 cursor-pointer transition-all hover:border-primary hover:shadow-md group"
            >
              <h4 className="text-[14px] font-semibold text-text-primary mb-1.5">
                {scorecard.name}
              </h4>
              {scorecard.description && (
                <p className="text-[12px] text-text-subtle leading-relaxed">
                  {scorecard.description}
                </p>
              )}
              <div className="mt-3 text-[12px] text-primary font-semibold">
                {scorecard.is_active ? 'Active' : 'Inactive'}
              </div>
            </Link>
          ))}

          {/* Create new card */}
          <Link
            to="/scorecards/new"
            className="border-2 border-dashed border-border rounded-card p-5 flex flex-col items-center justify-center text-text-muted cursor-pointer transition-all hover:text-primary hover:border-primary min-h-[120px]"
          >
            <span className="text-[28px] font-light leading-none mb-1">+</span>
            <span className="text-[12px] font-medium">Create New Scorecard</span>
          </Link>
        </div>
      )}
    </div>
  );
}

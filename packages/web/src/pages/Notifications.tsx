import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Notification } from '@callguard/shared';

export function Notifications() {
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () =>
      api.get<{ data: Notification[] }>(
        `/alerts/notifications?limit=100${unreadOnly ? '&unread_only=true' : ''}`
      ),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['notification-count'] });
    queryClient.invalidateQueries({ queryKey: ['notifications-recent'] });
  };

  const markRead = async (id: string) => {
    await api.post(`/alerts/notifications/${id}/read`);
    invalidate();
  };

  const markAllRead = async () => {
    await api.post('/alerts/notifications/mark-all-read');
    invalidate();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Notifications</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Alerts and updates for your account
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-table-cell text-text-cell">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            Unread only
          </label>
          <button
            onClick={markAllRead}
            className="text-table-cell text-primary hover:underline font-semibold"
          >
            Mark all read
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-text-muted text-table-cell">Loading...</div>
      ) : !data?.data.length ? (
        <div className="bg-white border border-dashed border-border rounded-card p-12 text-center">
          <p className="text-text-secondary font-semibold mb-1">No notifications</p>
          <p className="text-table-cell text-text-muted">
            You'll see alerts here when rules match or your calls need attention
          </p>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-card overflow-hidden">
          {data.data.map((n) => (
            <div
              key={n.id}
              onClick={() => !n.read_at && markRead(n.id)}
              className={`px-5 py-4 border-b border-border-light last:border-0 ${!n.read_at ? 'bg-primary-light/30 cursor-pointer hover:bg-primary-light' : ''}`}
            >
              <div className="flex items-start gap-3">
                <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${severityDot(n.severity)}`} />
                <div className="flex-1">
                  <div className="flex items-baseline justify-between">
                    <h4 className="text-table-cell font-semibold text-text-primary">{n.title}</h4>
                    <span className="text-[11px] text-text-muted ml-4 flex-shrink-0">
                      {new Date(n.created_at).toLocaleString()}
                    </span>
                  </div>
                  {n.body && <p className="text-table-cell text-text-secondary mt-1">{n.body}</p>}
                  {n.call_id && (
                    <Link
                      to={`/calls/${n.call_id}`}
                      className="inline-block mt-2 text-[12px] text-primary font-semibold hover:underline"
                    >
                      View call &rarr;
                    </Link>
                  )}
                </div>
                {!n.read_at && (
                  <span className="text-[11px] text-primary font-semibold uppercase tracking-wider">New</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function severityDot(s: string): string {
  switch (s) {
    case 'critical':
      return 'bg-fail';
    case 'warning':
      return 'bg-review';
    default:
      return 'bg-processing';
  }
}

import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Notification } from '@callguard/shared';

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: countData } = useQuery({
    queryKey: ['notification-count'],
    queryFn: () => api.get<{ count: number }>('/alerts/notifications/unread-count'),
    refetchInterval: 30_000,
  });

  const { data: recentData } = useQuery({
    queryKey: ['notifications-recent'],
    queryFn: () => api.get<{ data: Notification[] }>('/alerts/notifications?limit=5'),
    enabled: open,
  });

  const count = countData?.count || 0;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const markRead = async (id: string) => {
    await api.post(`/alerts/notifications/${id}/read`);
    queryClient.invalidateQueries({ queryKey: ['notification-count'] });
    queryClient.invalidateQueries({ queryKey: ['notifications-recent'] });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative w-10 h-10 rounded-full hover:bg-sidebar-hover flex items-center justify-center transition-colors"
        aria-label="Notifications"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5 stroke-text-secondary" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {count > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-fail text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 w-80 bg-white border border-border rounded-card shadow-lg z-50">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <span className="text-[13px] font-semibold text-text-primary">Notifications</span>
            <Link to="/notifications" onClick={() => setOpen(false)} className="text-[12px] text-primary font-medium hover:underline">
              View all
            </Link>
          </div>
          {!recentData?.data.length ? (
            <div className="px-4 py-8 text-center text-table-cell text-text-muted">No notifications</div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {recentData.data.map((n) => (
                <div
                  key={n.id}
                  className={`px-4 py-3 border-b border-border-light last:border-0 hover:bg-table-header cursor-pointer ${!n.read_at ? 'bg-primary-light/30' : ''}`}
                  onClick={() => markRead(n.id)}
                >
                  <div className="flex items-start gap-2">
                    <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${severityDot(n.severity)}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-text-primary truncate">{n.title}</div>
                      {n.body && <div className="text-[12px] text-text-secondary mt-0.5 line-clamp-2">{n.body}</div>}
                      <div className="text-[11px] text-text-muted mt-1">{timeAgo(n.created_at)}</div>
                    </div>
                    {n.call_id && (
                      <Link
                        to={`/calls/${n.call_id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(false);
                          markRead(n.id);
                        }}
                        className="text-[11px] text-primary font-medium hover:underline flex-shrink-0"
                      >
                        View
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function severityDot(s: string): string {
  switch (s) {
    case 'critical': return 'bg-fail';
    case 'warning': return 'bg-review';
    default: return 'bg-processing';
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

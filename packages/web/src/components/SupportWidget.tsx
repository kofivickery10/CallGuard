import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { ensureNotifyPermission, pingOnIncrease } from '../lib/browserPing';

interface SupportMessage {
  id: string;
  from_staff: boolean;
  body: string;
  created_at: string;
  sender_name: string | null;
}

export function SupportWidget() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['support-messages'],
    queryFn: () => api.get<{ data: SupportMessage[] }>('/support/messages'),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  // Unread staff replies — polled even while the widget is closed so the bubble
  // shows a red count when support replies. Cleared once the thread is opened
  // (fetching /support/messages marks it read server-side).
  const { data: unread } = useQuery({
    queryKey: ['support-unread'],
    queryFn: () => api.get<{ count: number }>('/support/unread-count'),
    enabled: !!user && !user.is_staff,
    refetchInterval: open ? false : 20000,
  });
  const unreadCount = open ? 0 : unread?.count ?? 0;

  // Clear the badge as soon as the open thread loads (server marked it read).
  useEffect(() => {
    if (open && data) queryClient.invalidateQueries({ queryKey: ['support-unread'] });
  }, [open, data, queryClient]);

  // Ask to enable desktop pings the first time the user opens support.
  useEffect(() => {
    if (open) void ensureNotifyPermission();
  }, [open]);

  // Desktop ping when a new staff reply arrives while the tab isn't focused.
  const prevUnreadRef = useRef<number | null>(null);
  useEffect(() => {
    if (unread === undefined) return;
    prevUnreadRef.current = pingOnIncrease(
      prevUnreadRef.current,
      unread.count,
      'CallGuard support',
      'You have a new reply from support.'
    );
  }, [unread?.count, unread]);

  const send = useMutation({
    mutationFn: (body: string) => api.post('/support/messages', { body }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['support-messages'] });
    },
  });

  const messages = data?.data ?? [];
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, open]);

  // Staff use the cross-tenant inbox, not the tenant widget.
  if (!user || user.is_staff) return null;

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-[340px] max-w-[calc(100vw-3rem)] bg-card border border-border rounded-card shadow-lg flex flex-col" style={{ height: '440px' }}>
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <div className="text-table-cell font-semibold text-text-primary">CallGuard support</div>
              <div className="text-[11px] text-text-muted">We usually reply within a few hours</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary text-lg leading-none">×</button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
            {messages.length === 0 && (
              <p className="text-[12px] text-text-muted text-center mt-6">
                Send us a message and we'll get back to you here.
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.from_staff ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-lg text-[13px] leading-relaxed ${
                    m.from_staff ? 'bg-table-header text-text-primary' : 'bg-primary text-white'
                  }`}
                >
                  {m.from_staff && <div className="text-[10px] font-semibold opacity-70 mb-0.5">Support</div>}
                  {m.body}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const b = draft.trim();
              if (b) send.mutate(b);
            }}
            className="p-3 border-t border-border flex gap-2"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
              className="flex-1 border border-border rounded-btn px-3 py-2 text-table-cell focus:outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={send.isPending || !draft.trim()}
              className="bg-primary text-white px-3 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center hover:bg-primary-hover transition-colors"
        title="Support"
        aria-label={unreadCount > 0 ? `Support chat, ${unreadCount} new replies` : 'Support chat'}
      >
        <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-fail text-white text-[11px] font-bold flex items-center justify-center border-2 border-page">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </>
  );
}

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ensureNotifyPermission } from '../lib/browserPing';

interface Thread {
  organization_id: string;
  organization_name: string;
  message_count: number;
  last_message_at: string;
  last_body: string;
  awaiting_reply: boolean;
  unread_count: number;
}
interface SupportMessage {
  id: string;
  from_staff: boolean;
  body: string;
  created_at: string;
  sender_name: string | null;
}

export function SupportInbox() {
  const queryClient = useQueryClient();
  const [activeOrg, setActiveOrg] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Enable desktop pings for new customer messages.
  useEffect(() => { void ensureNotifyPermission(); }, []);

  const { data: threadsData } = useQuery({
    queryKey: ['support-threads'],
    queryFn: () => api.get<{ data: Thread[] }>('/support/threads'),
    refetchInterval: 10000,
  });
  const threads = threadsData?.data ?? [];

  const { data: msgData } = useQuery({
    queryKey: ['support-thread', activeOrg],
    queryFn: () => api.get<{ data: SupportMessage[] }>(`/support/threads/${activeOrg}/messages`),
    enabled: !!activeOrg,
    refetchInterval: activeOrg ? 5000 : false,
  });
  const messages = msgData?.data ?? [];

  const reply = useMutation({
    mutationFn: (body: string) => api.post(`/support/threads/${activeOrg}/messages`, { body }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['support-thread', activeOrg] });
      queryClient.invalidateQueries({ queryKey: ['support-threads'] });
    },
  });

  const activeName = threads.find((t) => t.organization_id === activeOrg)?.organization_name;

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-page-title text-text-primary">Support inbox</h2>
        <p className="text-page-sub text-text-subtle mt-1">Conversations with your customers.</p>
      </div>

      <div className="flex gap-4 h-[600px]">
        {/* Threads */}
        <div className="w-[280px] flex-shrink-0 bg-card border border-border rounded-card overflow-y-auto">
          {threads.length === 0 && (
            <p className="text-xs text-text-muted p-4">No conversations yet.</p>
          )}
          {threads.map((t) => (
            <button
              key={t.organization_id}
              onClick={() => setActiveOrg(t.organization_id)}
              className={`w-full text-left px-4 py-3 border-b border-border-light hover:bg-sidebar-hover transition-colors ${
                activeOrg === t.organization_id ? 'bg-sidebar-active' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-table-cell font-semibold text-text-primary truncate">{t.organization_name}</span>
                {t.unread_count > 0 ? (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-fail text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0" title={`${t.unread_count} unread`}>
                    {t.unread_count > 99 ? '99+' : t.unread_count}
                  </span>
                ) : t.awaiting_reply ? (
                  <span className="w-2 h-2 rounded-full bg-fail flex-shrink-0" title="Awaiting your reply" />
                ) : null}
              </div>
              <div className="text-xs text-text-muted truncate mt-0.5">{t.last_body}</div>
            </button>
          ))}
        </div>

        {/* Thread */}
        <div className="flex-1 bg-card border border-border rounded-card flex flex-col">
          {!activeOrg ? (
            <div className="flex-1 flex items-center justify-center text-text-muted text-table-cell">
              Select a conversation
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-border text-table-cell font-semibold text-text-primary">
                {activeName}
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.from_staff ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] px-3 py-2 rounded-lg text-table-cell leading-relaxed ${
                      m.from_staff ? 'bg-primary text-white' : 'bg-table-header text-text-primary'
                    }`}>
                      {!m.from_staff && (
                        <div className="text-[10px] font-semibold opacity-70 mb-0.5">{m.sender_name || 'Customer'}</div>
                      )}
                      {m.body}
                    </div>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const b = draft.trim();
                  if (b) reply.mutate(b);
                }}
                className="p-3 border-t border-border flex gap-2"
              >
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Reply…"
                  className="flex-1 border border-border rounded-btn px-3 py-2 text-table-cell focus:outline-none focus:border-primary"
                />
                <button
                  type="submit"
                  disabled={reply.isPending || !draft.trim()}
                  className="bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover disabled:opacity-50"
                >
                  Send
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { SeverityBadge, StatusBadge } from './BreachBadges';
import {
  BREACH_STATUSES,
  BREACH_STATUS_LABELS,
  type BreachStatus,
  type BreachWithDetail,
  type BreachEvent,
  type AgentSummary,
} from '@callguard/shared';

interface BreachDetailDrawerProps {
  breachId: string;
  onClose: () => void;
}

type BreachDetailResponse = BreachWithDetail & { events: BreachEvent[] };

export function BreachDetailDrawer({ breachId, onClose }: BreachDetailDrawerProps) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: breach } = useQuery({
    queryKey: ['breach', breachId],
    queryFn: () => api.get<BreachDetailResponse>(`/breaches/${breachId}`),
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['breach', breachId] });
    queryClient.invalidateQueries({ queryKey: ['breaches'] });
    queryClient.invalidateQueries({ queryKey: ['breach-summary'] });
  };

  const handleStatusChange = async (status: BreachStatus) => {
    setSaving(true);
    try {
      await api.post(`/breaches/${breachId}/status`, { status });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleAssignChange = async (assigned_to: string) => {
    setSaving(true);
    try {
      await api.post(`/breaches/${breachId}/assign`, { assigned_to: assigned_to || null });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    try {
      await api.post(`/breaches/${breachId}/notes`, { note });
      setNote('');
      refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-text-primary/30" onClick={onClose} />
      <div className="w-[560px] bg-white border-l border-border shadow-xl overflow-y-auto">
        {!breach ? (
          <div className="p-8 text-text-muted">Loading...</div>
        ) : (
          <div>
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-border px-6 py-4 flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <SeverityBadge severity={breach.severity} />
                  <StatusBadge status={breach.status} />
                </div>
                <h3 className="text-[15px] font-semibold text-text-primary mt-2">{breach.breach_type}</h3>
                <p className="text-[12px] text-text-muted mt-0.5">
                  Detected {new Date(breach.detected_at).toLocaleString('en-GB')}
                </p>
              </div>
              <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1" aria-label="Close">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* Call context */}
              <Section title="Call">
                <div className="text-table-cell">
                  <Link to={`/calls/${breach.call_id}`} className="text-primary font-medium hover:underline">
                    {breach.call_file_name}
                  </Link>
                </div>
                {breach.agent_name && (
                  <div className="text-table-cell text-text-cell mt-1">
                    Agent: <span className="text-text-primary font-medium">{breach.agent_name}</span>
                  </div>
                )}
                {breach.scorecard_name && (
                  <div className="text-table-cell text-text-muted mt-1">
                    Scorecard: {breach.scorecard_name}
                  </div>
                )}
                <div className="mt-2 inline-flex items-center gap-2">
                  <span className="text-[12px] text-text-muted">Score:</span>
                  <span className="font-mono text-[15px] font-bold text-fail">
                    {Math.round(Number(breach.normalized_score))}%
                  </span>
                </div>
              </Section>

              {/* Evidence */}
              {breach.evidence && (
                <Section title="Evidence">
                  <blockquote className="bg-table-header border-l-[3px] border-fail rounded-r-btn px-3 py-2 italic text-table-cell text-text-cell">
                    "{breach.evidence}"
                  </blockquote>
                </Section>
              )}

              {/* AI reasoning */}
              {breach.reasoning && (
                <Section title="AI Reasoning">
                  <p className="text-table-cell text-text-cell">{breach.reasoning}</p>
                </Section>
              )}

              {/* Actions */}
              <Section title="Actions">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] text-text-muted mb-1">Status</label>
                    <select
                      value={breach.status}
                      onChange={(e) => handleStatusChange(e.target.value as BreachStatus)}
                      disabled={saving}
                      className={inputCls}
                    >
                      {BREACH_STATUSES.map((s) => (
                        <option key={s} value={s}>{BREACH_STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] text-text-muted mb-1">Assigned To</label>
                    <select
                      value={breach.assigned_to || ''}
                      onChange={(e) => handleAssignChange(e.target.value)}
                      disabled={saving}
                      className={inputCls}
                    >
                      <option value="">Unassigned</option>
                      {agents?.data.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </Section>

              {/* Add note */}
              <Section title="Add Note">
                <form onSubmit={handleAddNote} className="space-y-2">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Add a note for the audit trail..."
                    rows={3}
                    className={inputCls}
                  />
                  <button
                    type="submit"
                    disabled={saving || !note.trim()}
                    className="bg-primary text-white px-[14px] py-[7px] rounded-btn text-[12px] font-semibold hover:bg-primary-hover disabled:opacity-50 transition-colors"
                  >
                    Add Note
                  </button>
                </form>
              </Section>

              {/* Event timeline */}
              {breach.events && breach.events.length > 0 && (
                <Section title="Timeline">
                  <div className="space-y-3">
                    {breach.events.map((e) => (
                      <div key={e.id} className="border-l-2 border-border pl-3 py-1">
                        <div className="flex items-baseline justify-between">
                          <span className="text-[12px] font-semibold text-text-primary">
                            {formatEvent(e)}
                          </span>
                          <span className="text-[11px] text-text-muted ml-2">
                            {new Date(e.created_at).toLocaleString('en-GB')}
                          </span>
                        </div>
                        {e.note && (
                          <p className="text-[12px] text-text-cell mt-1 whitespace-pre-wrap">{e.note}</p>
                        )}
                        {e.user_name && (
                          <div className="text-[11px] text-text-muted mt-1">by {e.user_name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">{title}</h4>
      {children}
    </div>
  );
}

function formatEvent(e: BreachEvent): string {
  switch (e.event_type) {
    case 'status_changed':
      return `Status: ${e.from_value || '—'} → ${e.to_value || '—'}`;
    case 'assigned':
      return e.to_value ? 'Assigned' : 'Unassigned';
    case 'note_added':
      return 'Note added';
    case 'reopened':
      return 'Reopened';
    default:
      return e.event_type;
  }
}

const inputCls = "w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors";

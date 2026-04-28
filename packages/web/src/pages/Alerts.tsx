import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { AlertRuleModal } from '../components/AlertRuleModal';
import { ALERT_TRIGGER_LABELS, type AlertRule } from '@callguard/shared';

export function Alerts() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api.get<{ data: AlertRule[] }>('/alerts/rules'),
  });

  const handleEdit = (rule: AlertRule) => {
    setEditing(rule);
    setModalOpen(true);
  };

  const handleCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const handleTest = async (id: string) => {
    try {
      await api.post(`/alerts/rules/${id}/test`);
      alert('Test alert queued for delivery - check your channels');
    } catch (err) {
      alert(`Test failed: ${(err as Error).message}`);
    }
  };

  const handleToggle = async (rule: AlertRule) => {
    await api.put(`/alerts/rules/${rule.id}`, { is_active: !rule.is_active });
    queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this alert rule?')) return;
    await api.delete(`/alerts/rules/${id}`);
    queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Alerts</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Configure rules that notify your team when critical events happen
          </p>
        </div>
        <button
          onClick={handleCreate}
          className="bg-primary text-white px-[18px] py-[9px] rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
        >
          Create Rule
        </button>
      </div>

      {isLoading ? (
        <div className="text-text-muted text-table-cell">Loading...</div>
      ) : !data?.data.length ? (
        <div className="bg-white border border-dashed border-border rounded-card p-12 text-center">
          <p className="text-text-secondary font-semibold mb-1">No alert rules yet</p>
          <p className="text-table-cell text-text-muted mb-4">
            Create rules to get notified when calls fail critical checks
          </p>
          <button onClick={handleCreate} className="text-primary font-semibold text-table-cell hover:underline">
            Create your first rule
          </button>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr>
                {['Name', 'Trigger', 'Channels', 'Status', ''].map((h) => (
                  <th key={h} className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((rule) => (
                <tr key={rule.id} className="border-b border-border-light last:border-0">
                  <td className="px-5 py-3.5">
                    <div className="text-table-cell font-medium text-text-primary">{rule.name}</div>
                    {rule.description && <div className="text-[12px] text-text-muted mt-0.5">{rule.description}</div>}
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    {ALERT_TRIGGER_LABELS[rule.trigger_type]}
                    <div className="text-[11px] text-text-muted">{summarizeTrigger(rule)}</div>
                  </td>
                  <td className="px-5 py-3.5 text-table-cell text-text-cell">
                    <div className="flex gap-1.5">
                      {rule.channels.email && <ChannelChip label="Email" />}
                      {rule.channels.slack && <ChannelChip label="Slack" />}
                      {rule.channels.in_app && <ChannelChip label="In-app" />}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    {rule.is_active ? (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-pass-bg text-pass">Active</span>
                    ) : (
                      <span className="px-2.5 py-[3px] rounded-[20px] text-badge font-semibold bg-table-header text-text-muted">Paused</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-3 text-[12px]">
                      <button onClick={() => handleTest(rule.id)} className="text-text-muted hover:text-text-primary">Test</button>
                      <button onClick={() => handleToggle(rule)} className="text-text-muted hover:text-text-primary">
                        {rule.is_active ? 'Pause' : 'Activate'}
                      </button>
                      <button onClick={() => handleEdit(rule)} className="text-text-muted hover:text-text-primary">Edit</button>
                      <button onClick={() => handleDelete(rule.id)} className="text-text-muted hover:text-fail">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertRuleModal
        open={modalOpen}
        initial={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
      />
    </div>
  );
}

function ChannelChip({ label }: { label: string }) {
  return <span className="px-2 py-[2px] rounded text-[11px] font-semibold bg-primary-light text-pass">{label}</span>;
}

function summarizeTrigger(rule: AlertRule): string {
  const cfg = rule.trigger_config as Record<string, unknown>;
  if (rule.trigger_type === 'low_overall_score') {
    return `Score < ${cfg.threshold}%`;
  }
  if (rule.trigger_type === 'item_below_threshold') {
    return `Item score < ${cfg.threshold}%`;
  }
  return '';
}

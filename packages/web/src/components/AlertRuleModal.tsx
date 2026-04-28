import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  ALERT_TRIGGER_TYPES,
  ALERT_TRIGGER_LABELS,
  type AlertRule,
  type AlertTriggerType,
  type AlertChannelsConfig,
  type Scorecard,
  type ScorecardItem,
  type AgentSummary,
} from '@callguard/shared';

interface AlertRuleModalProps {
  open: boolean;
  initial: AlertRule | null;
  onClose: () => void;
}

export function AlertRuleModal({ open, initial, onClose }: AlertRuleModalProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<AlertTriggerType>('low_overall_score');
  const [threshold, setThreshold] = useState(70);
  const [selectedScorecardId, setSelectedScorecardId] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [emailEnabled, setEmailEnabled] = useState(true);
  const [emailRecipients, setEmailRecipients] = useState('');
  const [slackEnabled, setSlackEnabled] = useState(false);
  const [slackUrl, setSlackUrl] = useState('');
  const [inAppEnabled, setInAppEnabled] = useState(true);
  const [inAppTarget, setInAppTarget] = useState<'all_admins' | 'specific'>('all_admins');
  const [inAppUserIds, setInAppUserIds] = useState<string[]>([]);

  const { data: scorecards } = useQuery({
    queryKey: ['scorecards'],
    queryFn: () => api.get<{ data: Scorecard[] }>('/scorecards'),
    enabled: open,
  });

  const { data: scorecardDetail } = useQuery({
    queryKey: ['scorecard-detail', selectedScorecardId],
    queryFn: () => api.get<Scorecard & { items: ScorecardItem[] }>(`/scorecards/${selectedScorecardId}`),
    enabled: !!selectedScorecardId && triggerType === 'item_below_threshold',
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
    enabled: open,
  });

  // Load initial values when editing
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setDescription(initial.description || '');
      setTriggerType(initial.trigger_type);
      setIsActive(initial.is_active);

      const cfg = initial.trigger_config as Record<string, unknown>;
      if (initial.trigger_type === 'low_overall_score') {
        setThreshold(Number(cfg.threshold) || 70);
      } else if (initial.trigger_type === 'item_below_threshold') {
        setSelectedItemId(String(cfg.scorecard_item_id || ''));
        setThreshold(Number(cfg.threshold) || 50);
      }

      const channels = initial.channels;
      setEmailEnabled(!!channels.email);
      setEmailRecipients(channels.email?.recipients.join(', ') || '');
      setSlackEnabled(!!channels.slack);
      setSlackUrl(channels.slack?.webhook_url || '');
      setInAppEnabled(!!channels.in_app);
      if (channels.in_app?.user_ids === 'all_admins') {
        setInAppTarget('all_admins');
      } else if (Array.isArray(channels.in_app?.user_ids)) {
        setInAppTarget('specific');
        setInAppUserIds(channels.in_app.user_ids);
      }
    } else {
      setName('');
      setDescription('');
      setTriggerType('low_overall_score');
      setThreshold(70);
      setSelectedScorecardId('');
      setSelectedItemId('');
      setIsActive(true);
      setEmailEnabled(true);
      setEmailRecipients('');
      setSlackEnabled(false);
      setSlackUrl('');
      setInAppEnabled(true);
      setInAppTarget('all_admins');
      setInAppUserIds([]);
    }
  }, [open, initial]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const channels: AlertChannelsConfig = {};
    if (emailEnabled) {
      const recipients = emailRecipients.split(',').map((r) => r.trim()).filter(Boolean);
      if (recipients.length === 0) {
        setError('Email is enabled but no recipients specified');
        return;
      }
      channels.email = { recipients };
    }
    if (slackEnabled) {
      if (!slackUrl) {
        setError('Slack is enabled but webhook URL is empty');
        return;
      }
      channels.slack = { webhook_url: slackUrl };
    }
    if (inAppEnabled) {
      channels.in_app = {
        user_ids: inAppTarget === 'all_admins' ? 'all_admins' : inAppUserIds,
      };
    }

    if (!emailEnabled && !slackEnabled && !inAppEnabled) {
      setError('At least one channel must be enabled');
      return;
    }

    let trigger_config: Record<string, unknown> = {};
    if (triggerType === 'low_overall_score') {
      trigger_config = { threshold };
    } else if (triggerType === 'item_below_threshold') {
      if (!selectedItemId) {
        setError('Select a scorecard item');
        return;
      }
      trigger_config = { scorecard_item_id: selectedItemId, threshold };
    }

    setSaving(true);
    try {
      const payload = {
        name,
        description: description || undefined,
        trigger_type: triggerType,
        trigger_config,
        channels,
        is_active: isActive,
      };
      if (initial) {
        await api.put(`/alerts/rules/${initial.id}`, payload);
      } else {
        await api.post('/alerts/rules', payload);
      }
      queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto py-8">
      <div className="absolute inset-0 bg-text-primary/30" onClick={onClose} />
      <div className="relative bg-white border border-border rounded-card w-full max-w-2xl p-6 shadow-lg my-auto">
        <h3 className="text-[15px] font-semibold text-text-primary mb-4">
          {initial ? 'Edit Alert Rule' : 'Create Alert Rule'}
        </h3>

        {error && <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-3">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Rule Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} placeholder="e.g. Critical fail alert" />
          </Field>

          <Field label="Description (optional)">
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="When this rule fires..." />
          </Field>

          <Field label="Trigger Type">
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as AlertTriggerType)} className={inputCls}>
              {ALERT_TRIGGER_TYPES.map((t) => (
                <option key={t} value={t}>{ALERT_TRIGGER_LABELS[t]}</option>
              ))}
            </select>
          </Field>

          {/* Trigger config */}
          {triggerType === 'low_overall_score' && (
            <Field label="Score Threshold (fires if overall score < threshold)">
              <input
                type="number"
                min={0}
                max={100}
                value={threshold}
                onChange={(e) => setThreshold(parseInt(e.target.value) || 0)}
                className={inputCls}
              />
            </Field>
          )}

          {triggerType === 'item_below_threshold' && (
            <>
              <Field label="Scorecard">
                <select value={selectedScorecardId} onChange={(e) => { setSelectedScorecardId(e.target.value); setSelectedItemId(''); }} className={inputCls}>
                  <option value="">Select a scorecard</option>
                  {scorecards?.data.map((sc) => (
                    <option key={sc.id} value={sc.id}>{sc.name}</option>
                  ))}
                </select>
              </Field>
              {selectedScorecardId && (
                <Field label="Scorecard Item">
                  <select value={selectedItemId} onChange={(e) => setSelectedItemId(e.target.value)} className={inputCls} required>
                    <option value="">Select an item</option>
                    {scorecardDetail?.items.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Item Threshold (normalized, 0-100)">
                <input type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(parseInt(e.target.value) || 0)} className={inputCls} />
              </Field>
            </>
          )}

          {/* Channels */}
          <div className="border-t border-border-light pt-4">
            <label className="block text-[13px] font-semibold text-text-primary mb-3">Delivery Channels</label>

            <div className="space-y-3">
              {/* In-app */}
              <div className="border border-border rounded-btn p-3">
                <label className="flex items-center gap-2 text-table-cell text-text-primary font-medium">
                  <input type="checkbox" checked={inAppEnabled} onChange={(e) => setInAppEnabled(e.target.checked)} />
                  In-app notifications
                </label>
                {inAppEnabled && (
                  <div className="mt-2 pl-6 space-y-2">
                    <label className="flex items-center gap-2 text-table-cell text-text-cell">
                      <input type="radio" name="inapp" checked={inAppTarget === 'all_admins'} onChange={() => setInAppTarget('all_admins')} />
                      All admins in this org
                    </label>
                    <label className="flex items-center gap-2 text-table-cell text-text-cell">
                      <input type="radio" name="inapp" checked={inAppTarget === 'specific'} onChange={() => setInAppTarget('specific')} />
                      Specific users
                    </label>
                    {inAppTarget === 'specific' && agents && (
                      <select
                        multiple
                        value={inAppUserIds}
                        onChange={(e) => setInAppUserIds(Array.from(e.target.selectedOptions, (o) => o.value))}
                        className={inputCls + ' h-32'}
                      >
                        {agents.data.map((a) => (
                          <option key={a.id} value={a.id}>{a.name} ({a.email})</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>

              {/* Email */}
              <div className="border border-border rounded-btn p-3">
                <label className="flex items-center gap-2 text-table-cell text-text-primary font-medium">
                  <input type="checkbox" checked={emailEnabled} onChange={(e) => setEmailEnabled(e.target.checked)} />
                  Email
                </label>
                {emailEnabled && (
                  <input
                    type="text"
                    value={emailRecipients}
                    onChange={(e) => setEmailRecipients(e.target.value)}
                    placeholder="compliance@company.com, admin@company.com"
                    className={inputCls + ' mt-2'}
                  />
                )}
              </div>

              {/* Slack */}
              <div className="border border-border rounded-btn p-3">
                <label className="flex items-center gap-2 text-table-cell text-text-primary font-medium">
                  <input type="checkbox" checked={slackEnabled} onChange={(e) => setSlackEnabled(e.target.checked)} />
                  Slack
                </label>
                {slackEnabled && (
                  <input
                    type="text"
                    value={slackUrl}
                    onChange={(e) => setSlackUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/T00/B00/XX"
                    className={inputCls + ' mt-2 font-mono text-[12px]'}
                  />
                )}
              </div>
            </div>
          </div>

          <Field label="">
            <label className="flex items-center gap-2 text-table-cell text-text-cell">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active (fire this rule when triggers match)
            </label>
          </Field>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-white px-[18px] py-[9px] rounded-btn font-semibold text-table-cell hover:bg-primary-hover disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : initial ? 'Save Changes' : 'Create Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full border border-border rounded-btn px-3 py-2 text-table-cell text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <label className="block text-[12px] text-text-muted mb-1">{label}</label>}
      {children}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentSummary } from '@callguard/shared';

interface AgentFilterProps {
  value: string | null;
  onChange: (agent: string | null) => void;
  // Values to offer instead of the org's agent records.
  //
  // The sales list passes RESOLVED ADVISER NAMES rather than ids, and both
  // halves of that matter. GET /agents is admin-only and returns per-adviser
  // performance, so a supervisor could not populate this control from it; and a
  // large share of calls arrive unlinked (the dialler sends a display name, not
  // an id), so filtering sales by agent id would silently drop every sale whose
  // calls were never linked. GET /journeys/advisers answers with exactly the
  // names the list itself shows.
  options?: string[];
  // Every control needs an associated label (DESIGN_SYSTEM §7). Pass `id` to
  // wire up a visible <label>, or `label` for an accessible name where the
  // page has no room for one.
  id?: string;
  label?: string;
}

export function AgentFilter({ value, onChange, options, id, label }: AgentFilterProps) {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
    // Skipped entirely when the caller supplies its own options — the endpoint
    // is admin-only, so asking for it would 403 a supervisor.
    enabled: !options,
  });

  const choices: Array<{ value: string; label: string }> = options
    ? options.map((o) => ({ value: o, label: o }))
    : (data?.data ?? []).map((agent) => ({ value: agent.id, label: agent.name }));

  return (
    <select
      id={id}
      value={value || ''}
      aria-label={id ? undefined : (label ?? 'Filter by agent')}
      onChange={(e) => onChange(e.target.value || null)}
      className="border border-border rounded-btn px-3 py-[9px] text-table-cell text-text-primary bg-card transition-colors focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <option value="">{options ? 'All advisers' : 'All Agents'}</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>{choice.label}</option>
      ))}
    </select>
  );
}

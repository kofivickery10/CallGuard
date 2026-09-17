import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentSummary } from '@callguard/shared';

interface AgentFilterProps {
  value: string | null;
  onChange: (agentId: string | null) => void;
  /**
   * The advisers to offer. When omitted they are loaded from /agents, which is
   * admin-only — a page open to supervisors and viewers passes its own list
   * (e.g. GET /calls/advisers) rather than showing them an empty filter.
   */
  options?: Array<{ id: string; name: string }>;
  /** For a visible <label htmlFor> on the page; the select is named either way. */
  id?: string;
}

export function AgentFilter({ value, onChange, options, id }: AgentFilterProps) {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
    enabled: options === undefined,
  });
  const advisers = options ?? data?.data ?? [];

  return (
    <select
      id={id}
      value={value || ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Filter by adviser"
      className={`border rounded-btn px-3 py-[9px] text-table-cell bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        value ? 'border-primary text-primary-ink font-semibold' : 'border-border text-text-primary'
      }`}
    >
      <option value="">All advisers</option>
      {advisers.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </select>
  );
}

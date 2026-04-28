import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentSummary } from '@callguard/shared';

interface AgentFilterProps {
  value: string | null;
  onChange: (agentId: string | null) => void;
}

export function AgentFilter({ value, onChange }: AgentFilterProps) {
  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
  });

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="border border-border rounded-btn px-3 py-[9px] text-table-cell text-text-primary focus:outline-none focus:border-primary transition-colors bg-white"
    >
      <option value="">All Agents</option>
      {data?.data.map((agent) => (
        <option key={agent.id} value={agent.id}>{agent.name}</option>
      ))}
    </select>
  );
}

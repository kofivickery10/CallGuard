import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { AgentSummary } from '@callguard/shared';

interface AssignAgentDropdownProps {
  callId: string;
  currentAgentId: string | null;
}

export function AssignAgentDropdown({ callId, currentAgentId }: AssignAgentDropdownProps) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentSummary[] }>('/agents'),
  });

  const handleChange = async (agentId: string) => {
    setSaving(true);
    try {
      await api.post(`/calls/${callId}/assign-agent`, { agent_id: agentId || null });
      queryClient.invalidateQueries({ queryKey: ['call', callId] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-text-muted text-[12px]">Agent:</span>
      <select
        value={currentAgentId || ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="border border-border rounded-btn px-2 py-1 text-[12px] text-text-primary focus:outline-none focus:border-primary transition-colors bg-white disabled:opacity-50"
      >
        <option value="">Unassigned</option>
        {data?.data.map((agent) => (
          <option key={agent.id} value={agent.id}>{agent.name}</option>
        ))}
      </select>
    </span>
  );
}

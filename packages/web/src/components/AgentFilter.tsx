import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AgentSummary } from '@callguard/shared';

/**
 * The advisers to offer. Either shape is accepted because the two lists filter
 * by different things:
 *
 * - The calls list filters by adviser **id** — a call carries agent_id, so
 *   `{ id, name }` from GET /calls/advisers is exact.
 * - The sales list filters by resolved adviser **name**. A large share of calls
 *   arrive unlinked (the dialler sends a display name, not an id), so filtering
 *   sales by id would silently drop every sale whose calls were never linked.
 *   GET /journeys/advisers answers with exactly the names the list shows.
 *
 * When omitted, the advisers are loaded from GET /agents, which is admin-only —
 * a page open to supervisors and viewers passes its own list rather than
 * showing them an empty filter.
 */
type AgentFilterOptions = string[] | Array<{ id: string; name: string }>;

interface AgentFilterProps {
  value: string | null;
  onChange: (agent: string | null) => void;
  options?: AgentFilterOptions;
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
    enabled: options === undefined,
  });

  const source: AgentFilterOptions = options ?? data?.data ?? [];
  const choices = source.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : { value: o.id, label: o.name }
  );

  return (
    <select
      id={id}
      value={value || ''}
      aria-label={id ? undefined : (label ?? 'Filter by adviser')}
      onChange={(e) => onChange(e.target.value || null)}
      className={`border rounded-btn px-3 py-[9px] text-table-cell bg-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        value ? 'border-primary text-primary-ink font-semibold' : 'border-border text-text-primary'
      }`}
    >
      <option value="">All advisers</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

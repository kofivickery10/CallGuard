import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type { OrganizationInfo } from '@callguard/shared';

// Per-tenant module flags (organizations.capture_enabled etc.), distinct from
// the plan-tier entitlements in shared FEATURES/hasFeature: these are add-on
// modules switched per org by CallGuard staff, not derived from the plan.
// One shared query (cached 5 min — flags flip via superadmin ops, not
// mid-session) so nav, the Settings hub, and any page gate agree.
export type OrgFeature = 'capture';

export function useOrgFeatures(): Record<OrgFeature, boolean> {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ['organization'],
    queryFn: () => api.get<OrganizationInfo>('/organization'),
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  return { capture: data?.capture_enabled === true };
}

export interface Organization {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

// admin    - full access incl. all configuration
// supervisor - sees & actions all calls (review, correct, coach); no config
// viewer   - read-only across the whole org; no config, no uploads (leadership)
// adviser  - sees only their own calls/scores (front-line agent)
export type UserRole = 'admin' | 'supervisor' | 'viewer' | 'adviser';

// Roles that see org-wide data (everyone except advisers, who are scoped to self)
export const ORG_WIDE_ROLES: UserRole[] = ['admin', 'supervisor', 'viewer'];

export interface User {
  id: string;
  organization_id: string;
  // Null for a no-login adviser added by name alone.
  email: string | null;
  name: string;
  role: UserRole;
  // True for advisers added for call attribution + billing only — they cannot
  // sign in. Billing is unaffected (seats bill on presence, not login).
  login_disabled?: boolean;
  created_at: string;
  updated_at: string;
}

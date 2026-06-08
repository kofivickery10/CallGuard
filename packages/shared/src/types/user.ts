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
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

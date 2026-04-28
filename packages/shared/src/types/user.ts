export interface Organization {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  organization_id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

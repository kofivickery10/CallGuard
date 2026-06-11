export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface AuthRegisterInput {
  email: string;
  password: string;
  name: string;
  organization_name: string;
}

export interface AuthLoginInput {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  refresh_token: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    is_staff?: boolean;
    organization_id: string | null;
    organization_name: string;
    organization_plan: 'core' | 'professional' | 'enterprise' | null;
  };
}

export interface DashboardSummary {
  total_calls: number;
  scored_calls: number;
  average_score: number | null;
  pass_rate: number | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  email: string;
  total_calls: number;
  scored_calls: number;
  average_score: number | null;
  pass_rate: number | null;
}

export interface InviteAgentInput {
  email: string;
  name: string;
  password: string;
}

export interface ApiError {
  error: string;
  message: string;
}

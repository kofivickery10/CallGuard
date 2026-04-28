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
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    organization_id: string;
    organization_name: string;
    organization_plan: 'starter' | 'growth' | 'pro';
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

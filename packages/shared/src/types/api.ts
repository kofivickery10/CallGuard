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
  // Present (true) when the user logged in but has not yet enrolled in 2FA, which
  // is mandatory — the client must route them straight into enrolment.
  mfa_enrolment_required?: boolean;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    is_staff?: boolean;
    organization_id: string | null;
    organization_name: string;
    organization_plan: 'core' | 'professional' | 'enterprise' | null;
    totp_enabled?: boolean;
  };
}

// Returned by POST /auth/login when the user has 2FA enabled: the password was
// correct but a second factor is still required. No session is issued yet.
export interface TwoFactorChallengeResponse {
  two_factor_required: true;
  challenge_token: string;
  methods: Array<'totp' | 'email' | 'backup'>;
  email_hint: string;
}

// Returned by POST /auth/2fa/setup — the enrolment QR + manual key.
export interface TwoFactorSetupResponse {
  otpauth_url: string;
  qr_data_url: string;
  secret: string;
}

export interface DashboardSummary {
  total_calls: number;
  // Calls covered by scoring: per-call scored OR part of a scored sale.
  scored_calls: number;
  // Scored sales (journeys) — the scoring unit under the sales_only model.
  scored_sales: number;
  // Computed across all scored units (latest per-call scores + scored sales).
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

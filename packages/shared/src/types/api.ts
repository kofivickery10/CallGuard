import type { UserRole } from './user.js';
import type { FeedbackStatus, JourneyStatus } from './journey.js';

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
    // True when the account is exempt from mandatory 2FA (internal/setup logins).
    // The client must treat this as satisfying the enrolment gate: the API has
    // already issued a full mfa-satisfied session for these users, so routing
    // them to enrolment traps them in a loop the API will not let them complete.
    two_factor_exempt?: boolean;
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
  // Which of the two scoring shapes this org uses, decided by scoring_scope
  // (services/tenant-settings.ts) and never inferred from the CRM. The tiles
  // and the recent panel say "sales" or "calls" off this.
  mode: 'sales' | 'calls';
  // WHOSE numbers these are — decided here, by the scoping the query actually
  // applied, rather than guessed in the client from the reader's role. Only an
  // adviser is narrowed to themselves; a supervisor or viewer sees the whole
  // firm, and used to be told it was "your performance".
  scope: 'own' | 'adviser' | 'organisation';
  // Every scored unit behind average_score: the latest score per call plus each
  // scored sale. A rescore replaces its call's earlier score rather than
  // counting twice.
  scored_units: number;
  // Units carrying a pass/fail verdict — the pass-rate denominator. A unit
  // still holding a checkpoint for a person has no verdict and is left out of
  // it. Null under score_only, where no verdict-derived figure ships.
  units_with_verdict: number | null;
  // Computed across all scored units (latest per-call scores + scored sales).
  average_score: number | null;
  pass_rate: number | null;
  // Checkpoints the scorer would not rule on, waiting for a person to decide.
  // They sit outside average_score entirely (a held checkpoint carries no
  // numeric score), which is why the Average Score tile says so.
  items_to_review: number;
  // Whole days since the oldest of those was raised, or null when none wait.
  oldest_review_days: number | null;
}

// One row of the adviser leaderboard. Deliberately NOT AgentSummary: that type
// describes a member of the team (role, login state), while this describes the
// scored work credited to them — and its two figures have to be over the same
// population, which AgentSummary's call counts are not.
export interface LeaderboardRow {
  id: string;
  name: string;
  // The scored units behind average_score and pass_rate: this adviser's own
  // per-call scores plus the sales they closed. The column on screen and the
  // average beside it therefore count the same things — the old "Calls" column
  // showed calls next to an average over sales.
  scored_units: number;
  average_score: number | null;
  pass_rate: number | null;
}

export interface AgentLeaderboardResponse {
  data: LeaderboardRow[];
  mode: 'sales' | 'calls';
  // Scored units credited to nobody — a sale whose closing call carries no
  // adviser, or a call with no agent. They are in the org's average and in no
  // row of this table, so the table says how many it is not showing rather
  // than quietly summing to less than the tile above it.
  unattributed_units: number;
}

// One recent sale, for the dashboard's activity panel. A short form of the
// sales register's row (JourneyListItem) carrying only what five lines show.
export interface RecentSaleRow {
  id: string;
  customer_name: string | null;
  // The sale's closing adviser — the attribution used by breaches, the review
  // queue and the Zoho write-back.
  agent_name: string | null;
  sale_date: string | null;
  status: JourneyStatus;
  overall_score: number | null;
  // Null under score_only, where the verdict is withheld from the payload.
  pass: boolean | null;
  feedback_status: FeedbackStatus;
  items_to_review: number;
  items_failed: number;
}

// One recent call, for the same panel at a firm that scores calls individually.
export interface RecentCallRow {
  id: string;
  file_name: string;
  customer_name: string | null;
  agent_name: string | null;
  called_at: string;
  duration_seconds: number | null;
  status: string;
  overall_score: number | null;
  pass: boolean | null;
}

export type DashboardRecentResponse =
  | { mode: 'sales'; data: RecentSaleRow[] }
  | { mode: 'calls'; data: RecentCallRow[] };

export interface AgentSummary {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  total_calls: number;
  scored_calls: number;
  average_score: number | null;
  pass_rate: number | null;
  // True for a no-login adviser (attribution + billing only).
  login_disabled?: boolean;
  // True for a login-capable member who was invited by email but hasn't set a
  // password yet — the admin can resend the invite link.
  pending_invite?: boolean;
}

export interface InviteAgentInput {
  name: string;
  // Email + password are required only when the adviser can sign in. A no-login
  // adviser (can_login: false) can be added by name alone.
  email?: string;
  password?: string;
  role?: string;
  external_agent_id?: string;
  // Defaults to true (a normal, loginable account) when omitted.
  can_login?: boolean;
}

// Toggle sign-in access for an existing member. Enabling a member who has no
// password (a no-login adviser) requires a password in the same request.
export interface LoginAccessInput {
  can_login: boolean;
  password?: string;
  email?: string;
}

export interface ApiError {
  error: string;
  message: string;
}

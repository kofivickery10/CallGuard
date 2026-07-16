export type DialerProvider = 'cloudtalk';

// Tolerant field-name mapping for a dialer's inbound webhook payload — each
// value is a list of candidate keys to check, in order, since payload shape
// varies by tenant configuration.
export interface DialerFieldMap {
  call_id: string[];
  recording_url: string[];
  agent_email: string[];
  agent_external_id: string[];
  agent_name: string[];
  customer_phone: string[];
  // Candidate keys for call direction (inbound/outbound). Values are
  // normalised loosely (e.g. "incoming"/"in" -> inbound) — see
  // normalizeCallDirection in routes/ingestion.ts. Not confirmed present in
  // CloudTalk's payload for every tenant; absent/unrecognised values just
  // fall back to the org's mono_first_speaker default.
  direction: string[];
}

// Public shape returned to the admin UI — never includes encrypted secrets.
export interface DialerConnection {
  id: string;
  organization_id: string;
  provider: DialerProvider;
  name: string;
  api_base_url: string;
  recording_fetch_delay_seconds: number;
  history_window_days: number;
  field_map: DialerFieldMap;
  is_active: boolean;
  // Never returns the secrets themselves — just whether they're set.
  signing_secret_configured: boolean;
  api_credentials_configured: boolean;
  last_event_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DialerConnectionInput {
  provider?: DialerProvider;
  name?: string;
  api_base_url?: string;
  recording_fetch_delay_seconds?: number;
  history_window_days?: number;
  field_map?: Partial<DialerFieldMap>;
  is_active?: boolean;
  // Set/replace credentials. Omit any to keep the existing value.
  signing_secret?: string;
  api_key_id?: string;
  api_secret?: string;
}

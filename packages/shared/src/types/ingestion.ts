export interface ApiKey {
  id: string;
  organization_id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ApiKeyWithPlaintext extends ApiKey {
  plaintext_key: string;
}

export type SFTPAuthMethod = 'password' | 'privatekey';

export interface SFTPSource {
  id: string;
  organization_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: SFTPAuthMethod;
  remote_path: string;
  file_pattern: string | null;
  filename_template: string | null;
  poll_interval_minutes: number;
  is_active: boolean;
  last_polled_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SFTPSourceInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  auth_method: SFTPAuthMethod;
  password?: string;
  private_key?: string;
  remote_path?: string;
  file_pattern?: string;
  filename_template?: string;
  poll_interval_minutes?: number;
  is_active?: boolean;
}

export interface SFTPPollLog {
  id: string;
  source_id: string;
  started_at: string;
  completed_at: string | null;
  files_found: number;
  files_ingested: number;
  files_skipped: number;
  error_message: string | null;
}

export interface IngestCallInput {
  audio_url?: string;
  agent_name?: string;
  agent_external_id?: string;
  customer_phone?: string;
  call_date?: string;
  external_id?: string;
  tags?: string[];
}

export interface IngestCallResponse {
  id: string;
  status: string;
  external_id: string | null;
  created_at: string;
}

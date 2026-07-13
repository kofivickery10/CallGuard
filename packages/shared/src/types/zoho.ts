export type ZohoModule = 'Leads' | 'Contacts';

export type ZohoConnectionStatus = 'pending' | 'active' | 'disabled';

// Zoho data centre regions → accounts.zoho.<region> OAuth host.
export type ZohoRegion = 'eu' | 'com' | 'in' | 'com.au' | 'jp' | 'ca';

// API names of the custom fields CallGuard writes compliance results to.
export interface ZohoFieldMap {
  score: string;
  result: string;
  last_scored: string;
  link: string;
}

// API names of the fields on the QA custom module (adviser + month + score),
// so Trust Point can filter QA records by adviser + month for commission-tied
// averages.
export interface ZohoQAFieldMap {
  adviser: string;
  month: string;
  score: string;
  result: string;
  link: string;
}

// Public shape returned to the admin UI — never includes encrypted secrets.
export interface ZohoConnection {
  id: string;
  organization_id: string;
  dc_region: ZohoRegion;
  client_id: string;
  module: ZohoModule;
  field_map: ZohoFieldMap;
  // Which field on the inbound sale payload carries the customer's phone —
  // the journey-assembly key for the sale-trigger webhook.
  sale_phone_field: string;
  // Custom QA module API name. null = QA write-back not configured.
  qa_module: string | null;
  qa_field_map: ZohoQAFieldMap;
  // Whether the inbound sale-trigger secret has been set (never returns the
  // secret itself).
  inbound_configured: boolean;
  status: ZohoConnectionStatus;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// Body for creating/updating the connection's credentials + config.
export interface ZohoConnectionInput {
  dc_region?: ZohoRegion;
  client_id: string;
  client_secret?: string;
  module?: ZohoModule;
  field_map?: Partial<ZohoFieldMap>;
  sale_phone_field?: string;
  qa_module?: string | null;
  qa_field_map?: Partial<ZohoQAFieldMap>;
  // Set/replace the inbound sale-webhook secret. Omit to keep the existing one.
  inbound_secret?: string;
}

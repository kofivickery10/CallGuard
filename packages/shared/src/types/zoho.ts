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

// Public shape returned to the admin UI — never includes encrypted secrets.
export interface ZohoConnection {
  id: string;
  organization_id: string;
  dc_region: ZohoRegion;
  client_id: string;
  module: ZohoModule;
  field_map: ZohoFieldMap;
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
}

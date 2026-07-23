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

// API names of the fields on the tenant's QA module that CallGuard writes.
// CallGuard fills only the AI score component (the tenant's own formula
// averages it with their human QA marks), links the record to the sold-customer
// record, and optionally writes a free-text summary.
export interface ZohoQAFieldMap {
  // Numeric AI compliance score field (Trust Point: AI_Call_Score).
  score: string;
  // Required name field on the QA record (Trust Point: Name).
  client_name: string;
  // Lookup field to the sold-customer record (Trust Point: Client → Customers
  // Sold). Set to the record id carried on the sale trigger.
  customer_lookup: string;
  // Free-text field for the "what happened" summary. Empty string = not
  // configured; CallGuard then writes no summary (nothing breaks if the tenant
  // hasn't added a notes field yet).
  notes: string;
  // Text field for the closing agent's name. Empty string = not configured.
  // Distinct from the record Owner (which only works when the agent is a Zoho
  // user); this writes the dialler's agent name as plain text, so the agent is
  // visible even for tenants whose advisers aren't Zoho users.
  agent: string;
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
  // Product-aware scoring: read the products sold off a related module. All
  // null = product resolution not configured (scoring is unaffected).
  //   sale_module           — API name of the module the sale trigger fires
  //                           from, whose record id the payload carries
  //                           (e.g. 'Customers_Sold').
  //   policies_related_list — API name of the related list holding the products
  //                           (e.g. 'Policies_Sold').
  //   policy_product_field  — API name of the field on a policy record carrying
  //                           the product value (maps to products.external_key).
  sale_module: string | null;
  policies_related_list: string | null;
  policy_product_field: string | null;
  // Whether the inbound sale-trigger secret has been set (never returns the
  // secret itself). When set, the sale-trigger endpoint enforces the HMAC
  // signature; when unset the trigger runs API-key-only.
  inbound_configured: boolean;
  // Admin has confirmed the Zoho sale trigger is configured. Together with an
  // active status this activates sales_only metadata capture even without a
  // signing secret (the API-key-only path for Zoho's plain Webhook action).
  sale_trigger_enabled: boolean;
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
  sale_module?: string | null;
  policies_related_list?: string | null;
  policy_product_field?: string | null;
  // Set/replace the inbound sale-webhook secret. Omit to keep the existing one.
  inbound_secret?: string;
  // Mark the sale trigger as configured (activates capture without a secret).
  sale_trigger_enabled?: boolean;
}

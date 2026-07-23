// How a journey's product set was determined:
//   'crm'  — read from the CRM related list (e.g. Zoho "Policies Sold")
//   'ai'   — inferred from the transcript (fallback when the CRM had nothing)
//   'none' — org not configured for products, or resolution found nothing
export type ProductSource = 'crm' | 'ai' | 'none';

// A per-org catalogue product (e.g. a protection-insurance policy type). Items
// on a scorecard can be scoped to a set of these; a journey (sale) records the
// set it actually covered.
export interface Product {
  id: string;
  organization_id: string;
  name: string;
  // The CRM value that identifies this product on an inbound sale (maps a Zoho
  // "Policies Sold" product value onto this catalogue entry). Null for products
  // that only ever arrive via the AI transcript fallback or manual tagging.
  external_key: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProductInput {
  name: string;
  external_key?: string | null;
  is_active?: boolean;
  sort_order?: number;
}

// A product a journey (sale) covered, with how it was determined. product_name
// is snapshotted so a sale stays readable after a product is renamed/removed.
export interface JourneyProduct {
  id: string;
  journey_id: string;
  product_id: string | null;
  product_name: string;
  source: ProductSource;
  created_at: string;
}

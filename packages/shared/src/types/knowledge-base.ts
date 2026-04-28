export const KB_SECTION_TYPES = [
  'company_overview',
  'products',
  'compliance',
  'scripts',
  'objections',
  'glossary',
] as const;

export type KBSectionType = (typeof KB_SECTION_TYPES)[number];

export const KB_SECTION_LABELS: Record<KBSectionType, string> = {
  company_overview: 'Company Overview',
  products: 'Products & Pricing',
  compliance: 'Compliance Rules',
  scripts: 'Sales Scripts',
  objections: 'Common Objections',
  glossary: 'Industry Terms',
};

export const KB_SECTION_HINTS: Record<KBSectionType, string> = {
  company_overview:
    'Describe your business, what you sell, your market, and your tone/brand voice.',
  products:
    'List your products/packages with pricing, features, contract lengths, and any offers.',
  compliance:
    'List the compliance rules agents must follow (DPA, disclosures, cooling-off, vulnerability handling, mandatory statements, etc).',
  scripts:
    'Paste your expected call flow / sales script so the AI knows what good looks like.',
  objections:
    'List common customer objections and how agents should handle them.',
  glossary:
    'Define industry terms, product codenames, and internal jargon so the AI understands your vocabulary.',
};

export interface KBFile {
  id: string;
  section_id: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number | null;
  created_at: string;
}

export interface KBSection {
  id: string;
  organization_id: string;
  section_type: KBSectionType;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  files?: KBFile[];
}

export interface UpsertKBSectionInput {
  content: string;
}

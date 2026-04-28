import fs from 'fs/promises';
import path from 'path';

export interface DocType {
  id: 'dpia' | 'dpa' | 'ropa' | 'security-policy';
  title: string;
  description: string;
  file: string;
}

export const DOC_TYPES: DocType[] = [
  {
    id: 'dpia',
    title: 'Data Protection Impact Assessment',
    description: 'Analyses risks and safeguards for processing personal data via CallGuard. Required under UK GDPR Article 35 for high-risk processing.',
    file: 'dpia.md',
  },
  {
    id: 'dpa',
    title: 'Data Processing Agreement',
    description: 'The contract between your firm (Controller) and CallGuard (Processor) under UK GDPR Article 28. Sign before processing any personal data.',
    file: 'dpa.md',
  },
  {
    id: 'ropa',
    title: 'Records of Processing Activities',
    description: 'Your RoPA documenting CallGuard-related processing activities. Required under UK GDPR Article 30.',
    file: 'ropa.md',
  },
  {
    id: 'security-policy',
    title: 'Information Security Policy',
    description: 'Internal policy for secure use of CallGuard, covering access control, data handling, and incident response.',
    file: 'security-policy.md',
  },
];

export function findDocType(id: string): DocType | null {
  return DOC_TYPES.find((t) => t.id === id) || null;
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return vars[key] !== undefined ? vars[key] : `{{${key}}}`;
  });
}

export async function loadTemplate(file: string): Promise<string> {
  // Try dist layout first (compiled), then fall back to src (tsx dev)
  const candidates = [
    path.resolve(__dirname, '..', 'templates', 'compliance', file),
    path.resolve(__dirname, '..', '..', 'src', 'templates', 'compliance', file),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf-8');
    } catch {
      // try next
    }
  }
  throw new Error(`Template not found: ${file}`);
}

export async function renderDocument(
  type: DocType['id'],
  vars: Record<string, string>
): Promise<{ markdown: string; html: string; title: string }> {
  const docType = findDocType(type);
  if (!docType) throw new Error(`Unknown doc type: ${type}`);

  const template = await loadTemplate(docType.file);
  const markdown = renderTemplate(template, vars);

  // Convert to HTML
  const { marked } = await import('marked');
  const html = await marked.parse(markdown);

  return { markdown, html, title: docType.title };
}

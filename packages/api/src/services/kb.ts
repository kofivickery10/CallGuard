import { query } from '../db/client.js';
import { KB_SECTION_LABELS, KB_SECTION_TYPES } from '@callguard/shared';
import type { KBSectionType } from '@callguard/shared';

interface SectionRow {
  id: string;
  section_type: KBSectionType;
  content: string;
}

interface FileRow {
  section_id: string;
  file_name: string;
  extracted_text: string;
}

/**
 * Returns formatted KB context markdown for an organization, or empty string
 * if the KB is empty. Used by both transcript cleanup and scoring prompts.
 */
export async function getKBContext(organizationId: string): Promise<string> {
  const sections = await query<SectionRow>(
    `SELECT id, section_type, content
     FROM knowledge_base_sections
     WHERE organization_id = $1`,
    [organizationId]
  );

  if (sections.length === 0) return '';

  const files = await query<FileRow>(
    `SELECT kbf.section_id, kbf.file_name, kbf.extracted_text
     FROM knowledge_base_files kbf
     JOIN knowledge_base_sections kbs ON kbs.id = kbf.section_id
     WHERE kbs.organization_id = $1`,
    [organizationId]
  );

  const filesBySection = new Map<string, FileRow[]>();
  for (const file of files) {
    const existing = filesBySection.get(file.section_id) || [];
    existing.push(file);
    filesBySection.set(file.section_id, existing);
  }

  // Order sections by our canonical order, skip empty ones
  const blocks: string[] = [];

  for (const sectionType of KB_SECTION_TYPES) {
    const section = sections.find((s) => s.section_type === sectionType);
    if (!section) continue;

    const sectionFiles = filesBySection.get(section.id) || [];
    const hasContent = section.content.trim().length > 0;
    const hasFiles = sectionFiles.length > 0;
    if (!hasContent && !hasFiles) continue;

    let block = `### ${KB_SECTION_LABELS[sectionType]}\n`;
    if (hasContent) block += `${section.content.trim()}\n`;
    for (const file of sectionFiles) {
      block += `\n[Attached: ${file.file_name}]\n${file.extracted_text}\n`;
    }
    blocks.push(block);
  }

  if (blocks.length === 0) return '';

  return blocks.join('\n');
}

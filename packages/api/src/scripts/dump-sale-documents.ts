// Pull every attachment on a sale and write its extracted text to disk.
//
// The bench for working out how to read an insurer's document. Reconciliation
// reads a PDF through extractPdfText and then parses the TEXT, so the text is
// the thing a parse config has to be designed against — reading the PDF in a
// viewer shows a layout the parser never sees.
//
// READ ONLY. Downloads from the CRM, writes text files locally, touches no
// database row.
//
// The files carry real customer data. Write them somewhere temporary and delete
// them when you are done — do not put them in the repo.
//
// Usage:
//   tsx src/scripts/dump-sale-documents.ts <journey-id> <out-dir>
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pool, queryOne } from '../db/client.js';
import { listSaleAttachments, downloadSaleAttachment } from '../services/zoho.js';
import { extractPdfText, rankAttachmentCandidates } from '../services/application-pdf.js';

async function main(): Promise<void> {
  const journeyId = process.argv[2];
  const outDir = process.argv[3];
  if (!journeyId || !outDir) {
    console.log('Usage: tsx src/scripts/dump-sale-documents.ts <journey-id> <out-dir>');
    return;
  }

  const journey = await queryOne<{ organization_id: string; zoho_record_id: string | null }>(
    'SELECT organization_id, zoho_record_id FROM journeys WHERE id = $1',
    [journeyId]
  );
  if (!journey?.zoho_record_id) {
    console.log('No such journey, or it has no CRM record.');
    return;
  }

  const { configured, attachments } = await listSaleAttachments(
    journey.organization_id,
    journey.zoho_record_id
  );
  if (!configured) {
    console.log('The CRM connection is not configured for attachment reads.');
    return;
  }

  await mkdir(outDir, { recursive: true });
  // Ranked, and numbered by rank in the filename: which document reconciliation
  // would reach FIRST is half of what you are trying to work out.
  const ranked = rankAttachmentCandidates(attachments);
  let rank = 0;
  for (const a of ranked) {
    rank++;
    let text: string;
    try {
      text = await extractPdfText(await downloadSaleAttachment(journey.organization_id, journey.zoho_record_id, a.id));
    } catch (err) {
      console.log(`${String(rank).padStart(2)}. ${a.file_name} — unreadable: ${(err as Error).message}`);
      continue;
    }
    const file = path.join(outDir, `${String(rank).padStart(2, '0')}_${a.file_name.replace(/[^\w.-]+/g, '_')}.txt`);
    await writeFile(file, text, 'utf8');
    console.log(`${String(rank).padStart(2)}. ${a.file_name} — ${text.length} chars -> ${file}`);
  }

  const unranked = attachments.filter((a) => !ranked.some((r) => r.id === a.id));
  for (const a of unranked) console.log(` -. ${a.file_name} — dropped by the ranking (not downloadable)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

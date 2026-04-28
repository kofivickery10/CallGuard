import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { uploadKB } from '../middleware/upload.js';
import { query, queryOne } from '../db/client.js';
import { uploadFile, readFile, deleteFile } from '../services/storage.js';
import { parseFileToText } from '../services/kb-parser.js';
import { AppError } from '../middleware/errors.js';
import { KB_SECTION_TYPES } from '@callguard/shared';
import type { KBSection, KBFile, KBSectionType } from '@callguard/shared';

export const kbRouter = Router();
kbRouter.use(authenticate);

function isValidSectionType(v: string | string[] | undefined): v is KBSectionType {
  return typeof v === 'string' && (KB_SECTION_TYPES as readonly string[]).includes(v);
}

// List all sections with files metadata
kbRouter.get('/', async (req, res, next) => {
  try {
    const sections = await query<KBSection>(
      `SELECT * FROM knowledge_base_sections WHERE organization_id = $1`,
      [req.user!.organizationId]
    );

    const sectionIds = sections.map((s) => s.id);
    const files = sectionIds.length > 0
      ? await query<KBFile>(
          `SELECT id, section_id, file_name, mime_type, file_size_bytes, created_at
           FROM knowledge_base_files WHERE section_id = ANY($1::uuid[])`,
          [sectionIds]
        )
      : [];

    const sectionsWithFiles = sections.map((s) => ({
      ...s,
      files: files.filter((f) => f.section_id === s.id),
    }));

    res.json({ data: sectionsWithFiles });
  } catch (err) {
    next(err);
  }
});

// Get a single section by type
kbRouter.get('/:section_type', async (req, res, next) => {
  try {
    const sectionType = req.params.section_type;
    if (!isValidSectionType(sectionType)) throw new AppError(400, 'Invalid section type');

    const section = await queryOne<KBSection>(
      `SELECT * FROM knowledge_base_sections
       WHERE organization_id = $1 AND section_type = $2`,
      [req.user!.organizationId, sectionType]
    );

    if (!section) {
      res.json({ section_type: sectionType, content: '', files: [] });
      return;
    }

    const files = await query<KBFile>(
      `SELECT id, section_id, file_name, mime_type, file_size_bytes, created_at
       FROM knowledge_base_files WHERE section_id = $1 ORDER BY created_at`,
      [section.id]
    );

    res.json({ ...section, files });
  } catch (err) {
    next(err);
  }
});

// Upsert section content (admin only)
kbRouter.put('/:section_type', requireAdmin, async (req, res, next) => {
  try {
    const sectionType = req.params.section_type;
    if (!isValidSectionType(sectionType)) throw new AppError(400, 'Invalid section type');

    const { content = '' } = req.body;

    const rows = await query<KBSection>(
      `INSERT INTO knowledge_base_sections (organization_id, section_type, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, section_type)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now()
       RETURNING *`,
      [req.user!.organizationId, sectionType, content]
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Upload file to section (admin only)
kbRouter.post(
  '/:section_type/files',
  requireAdmin,
  uploadKB.single('file'),
  async (req, res, next) => {
    try {
      const sectionType = req.params.section_type;
      if (!isValidSectionType(sectionType)) throw new AppError(400, 'Invalid section type');
      if (!req.file) throw new AppError(400, 'No file uploaded');

      // Ensure section exists
      const section = await queryOne<KBSection>(
        `INSERT INTO knowledge_base_sections (organization_id, section_type)
         VALUES ($1, $2)
         ON CONFLICT (organization_id, section_type) DO UPDATE SET updated_at = now()
         RETURNING *`,
        [req.user!.organizationId, sectionType]
      );
      if (!section) throw new AppError(500, 'Could not create/find section');

      // Parse file to text
      const extractedText = await parseFileToText(req.file.buffer, req.file.mimetype);

      // Save to disk
      const fileId = uuid();
      const fileKey = `kb/${req.user!.organizationId}/${section.id}/${fileId}/${req.file.originalname}`;
      await uploadFile(fileKey, req.file.buffer, req.file.mimetype);

      // Insert DB record (always encrypted on new uploads)
      const rows = await query<KBFile>(
        `INSERT INTO knowledge_base_files
          (id, section_id, file_name, file_key, mime_type, file_size_bytes, extracted_text, encrypted_at_rest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         RETURNING id, section_id, file_name, mime_type, file_size_bytes, created_at`,
        [
          fileId,
          section.id,
          req.file.originalname,
          fileKey,
          req.file.mimetype,
          req.file.size,
          extractedText,
        ]
      );

      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// Delete a file (admin only)
kbRouter.delete('/files/:file_id', requireAdmin, async (req, res, next) => {
  try {
    const file = await queryOne<{ id: string; file_key: string }>(
      `SELECT kbf.id, kbf.file_key
       FROM knowledge_base_files kbf
       JOIN knowledge_base_sections kbs ON kbs.id = kbf.section_id
       WHERE kbf.id = $1 AND kbs.organization_id = $2`,
      [req.params.file_id, req.user!.organizationId]
    );
    if (!file) throw new AppError(404, 'File not found');

    await query('DELETE FROM knowledge_base_files WHERE id = $1', [file.id]);

    // Best-effort remove from disk
    await deleteFile(file.file_key).catch(() => { /* ignore */ });

    res.json({ message: 'File deleted' });
  } catch (err) {
    next(err);
  }
});

// Download original file (decrypts if stored encrypted)
kbRouter.get('/files/:file_id/download', async (req, res, next) => {
  try {
    const file = await queryOne<{
      file_key: string;
      file_name: string;
      mime_type: string;
      encrypted_at_rest: boolean;
    }>(
      `SELECT kbf.file_key, kbf.file_name, kbf.mime_type, kbf.encrypted_at_rest
       FROM knowledge_base_files kbf
       JOIN knowledge_base_sections kbs ON kbs.id = kbf.section_id
       WHERE kbf.id = $1 AND kbs.organization_id = $2`,
      [req.params.file_id, req.user!.organizationId]
    );
    if (!file) throw new AppError(404, 'File not found');

    const buffer = await readFile(file.file_key, file.encrypted_at_rest);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

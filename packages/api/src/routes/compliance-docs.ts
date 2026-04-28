import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { DOC_TYPES, findDocType, renderDocument } from '../services/doc-generator.js';

export const complianceDocsRouter = Router();
complianceDocsRouter.use(authenticate);
complianceDocsRouter.use(requireAdmin);

complianceDocsRouter.get('/', (_req, res) => {
  res.json({
    data: DOC_TYPES.map((d) => ({ id: d.id, title: d.title, description: d.description })),
  });
});

complianceDocsRouter.post('/:type/render', async (req, res, next) => {
  try {
    const docType = findDocType(req.params.type);
    if (!docType) throw new AppError(404, 'Unknown document type');

    const { data_controller_name, dpo_email } = req.body;
    if (!data_controller_name || !dpo_email) {
      throw new AppError(400, 'data_controller_name and dpo_email are required');
    }

    const org = await queryOne<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [req.user!.organizationId]
    );
    if (!org) throw new AppError(404, 'Organisation not found');

    const vars = {
      organization_name: org.name,
      generated_date: new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }),
      data_controller_name: String(data_controller_name),
      dpo_email: String(dpo_email),
    };

    const result = await renderDocument(docType.id, vars);
    res.json({
      type: docType.id,
      title: result.title,
      markdown: result.markdown,
      html: result.html,
    });
  } catch (err) {
    next(err);
  }
});

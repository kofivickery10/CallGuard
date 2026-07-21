import { Router } from 'express';
import { authenticate, requireAdmin, requireOrgView } from '../middleware/auth.js';
import { query, queryOne, withTransaction } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';
import { scoringQueue } from '../jobs/queue.js';
import { getCaptureForm } from '../services/capture-runs.js';
import type {
  CaptureForm,
  CaptureFormField,
  CaptureFormFieldInput,
  CaptureFormRule,
  CaptureRun,
  CaptureAnswer,
  CaptureAnswerType,
  CapturePiiClass,
} from '@callguard/shared';

// ============================================================
// Data Capture module routes (generic, cross-tenant). Forms/rules are
// set-once config (admin); runs/answers are org-wide read (excludes
// advisers, like the rest of the Quality/Compliance surfaces).
// ============================================================

export const captureRouter = Router();
captureRouter.use(authenticate, requireOrgView);

const ANSWER_TYPES: CaptureAnswerType[] = ['text', 'yes_no', 'number', 'currency', 'date', 'choice'];
const PII_CLASSES: CapturePiiClass[] = ['none', 'personal', 'health'];

function validateFields(fields: unknown): CaptureFormFieldInput[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new AppError(400, 'fields must be a non-empty array');
  }
  if (fields.length > 100) {
    throw new AppError(400, 'a form may have at most 100 fields');
  }
  return fields.map((f, i) => {
    const field = f as CaptureFormFieldInput;
    if (!field.label || typeof field.label !== 'string' || !field.label.trim()) {
      throw new AppError(400, `fields[${i}].label is required`);
    }
    const answerType = field.answer_type ?? 'text';
    if (!ANSWER_TYPES.includes(answerType)) {
      throw new AppError(400, `fields[${i}].answer_type must be one of ${ANSWER_TYPES.join(', ')}`);
    }
    const piiClass = field.pii_class ?? 'none';
    if (!PII_CLASSES.includes(piiClass)) {
      throw new AppError(400, `fields[${i}].pii_class must be one of ${PII_CLASSES.join(', ')}`);
    }
    if (answerType === 'choice' && (!Array.isArray(field.choices) || field.choices.length === 0)) {
      throw new AppError(400, `fields[${i}].choices is required for answer_type 'choice'`);
    }
    return {
      label: field.label.trim(),
      description: field.description?.trim() || null,
      answer_type: answerType,
      choices: answerType === 'choice' ? (field.choices as string[]) : null,
      required: field.required !== false,
      pii_class: piiClass,
      applies_when: field.applies_when?.trim() || null,
      sort_order: typeof field.sort_order === 'number' ? field.sort_order : i,
    };
  });
}

// ---------- Forms ----------

captureRouter.get('/forms', async (req, res, next) => {
  try {
    const forms = await query<CaptureForm & { field_count: string }>(
      `SELECT cf.*,
              (SELECT COUNT(*) FROM capture_form_fields f
                WHERE f.form_id = cf.id AND f.archived_at IS NULL)::text AS field_count
         FROM capture_forms cf
        WHERE cf.organization_id = $1 AND cf.archived_at IS NULL
        ORDER BY cf.created_at DESC`,
      [req.user!.organizationId]
    );
    res.json({ data: forms });
  } catch (err) {
    next(err);
  }
});

captureRouter.get('/forms/:id', async (req, res, next) => {
  try {
    const form = await getCaptureForm(req.user!.organizationId, req.params.id);
    if (!form) throw new AppError(404, 'Capture form not found');
    res.json(form);
  } catch (err) {
    next(err);
  }
});

captureRouter.post('/forms', requireAdmin, async (req, res, next) => {
  try {
    const { name, context_label, fields } = req.body as {
      name?: string;
      context_label?: string | null;
      fields?: unknown;
    };
    if (!name || !name.trim()) throw new AppError(400, 'name is required');
    const validated = validateFields(fields);

    const form = await withTransaction(async (tx) => {
      const created = await tx.query<CaptureForm>(
        `INSERT INTO capture_forms (organization_id, name, context_label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user!.organizationId, name.trim(), context_label?.trim() || null, req.user!.userId]
      );
      const f = created[0]!;
      for (const field of validated) {
        await tx.query(
          `INSERT INTO capture_form_fields
             (form_id, sort_order, label, description, answer_type, choices, required, pii_class, applies_when)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [f.id, field.sort_order, field.label, field.description, field.answer_type,
           field.choices ? JSON.stringify(field.choices) : null, field.required, field.pii_class, field.applies_when]
        );
      }
      return f;
    });

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'capture_form.create',
      entityType: 'capture_form',
      entityId: form.id,
      metadata: { name: form.name, field_count: validated.length },
    });

    const full = await getCaptureForm(req.user!.organizationId, form.id);
    res.status(201).json(full);
  } catch (err) {
    next(err);
  }
});

// Replace a form's definition. Fields are archived-and-replaced (never
// deleted — completed runs' answers reference them), and the version bumps
// when the form has already been captured against, so answers stay pinned to
// the definition they were extracted with — same model as scorecard edits.
captureRouter.put('/forms/:id', requireAdmin, async (req, res, next) => {
  try {
    const existing = await queryOne<CaptureForm>(
      'SELECT * FROM capture_forms WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
      [req.params.id, req.user!.organizationId]
    );
    if (!existing) throw new AppError(404, 'Capture form not found');

    const { name, context_label, is_active, fields } = req.body as {
      name?: string;
      context_label?: string | null;
      is_active?: boolean;
      fields?: unknown;
    };
    const validated = fields !== undefined ? validateFields(fields) : null;

    const hasRuns = validated
      ? !!(await queryOne<{ id: string }>(
          `SELECT id FROM capture_runs WHERE form_id = $1 AND status IN ('running', 'completed') LIMIT 1`,
          [existing.id]
        ))
      : false;

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE capture_forms
            SET name = COALESCE($2, name),
                context_label = COALESCE($3, context_label),
                is_active = COALESCE($4, is_active),
                version = version + $5,
                updated_at = now()
          WHERE id = $1`,
        [existing.id, name?.trim() || null, context_label?.trim() ?? null,
         typeof is_active === 'boolean' ? is_active : null, hasRuns ? 1 : 0]
      );
      if (validated) {
        await tx.query(
          'UPDATE capture_form_fields SET archived_at = now() WHERE form_id = $1 AND archived_at IS NULL',
          [existing.id]
        );
        for (const field of validated) {
          await tx.query(
            `INSERT INTO capture_form_fields
               (form_id, sort_order, label, description, answer_type, choices, required, pii_class, applies_when)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [existing.id, field.sort_order, field.label, field.description, field.answer_type,
             field.choices ? JSON.stringify(field.choices) : null, field.required, field.pii_class, field.applies_when]
          );
        }
      }
    });

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'capture_form.update',
      entityType: 'capture_form',
      entityId: existing.id,
      metadata: { fields_replaced: !!validated, version_bumped: hasRuns },
    });

    const full = await getCaptureForm(req.user!.organizationId, existing.id);
    res.json(full);
  } catch (err) {
    next(err);
  }
});

captureRouter.post('/forms/:id/archive', requireAdmin, async (req, res, next) => {
  try {
    const rows = await query<{ id: string }>(
      `UPDATE capture_forms SET archived_at = now(), is_active = false, updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
        RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (rows.length === 0) throw new AppError(404, 'Capture form not found');
    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'capture_form.archive',
      entityType: 'capture_form',
      entityId: req.params.id,
    });
    res.json({ message: 'Capture form archived' });
  } catch (err) {
    next(err);
  }
});

// ---------- Resolution rules ----------

captureRouter.get('/rules', async (req, res, next) => {
  try {
    const rules = await query<CaptureFormRule>(
      `SELECT * FROM capture_form_rules
        WHERE organization_id = $1 AND is_active
        ORDER BY priority DESC, created_at ASC`,
      [req.user!.organizationId]
    );
    res.json({ data: rules });
  } catch (err) {
    next(err);
  }
});

captureRouter.post('/rules', requireAdmin, async (req, res, next) => {
  try {
    const { form_id, source, source_key, match_value, priority } = req.body as {
      form_id?: string;
      source?: string;
      source_key?: string;
      match_value?: string;
      priority?: number;
    };
    if (!form_id) throw new AppError(400, 'form_id is required');
    if (source !== 'crm_field' && source !== 'source_document' && source !== 'manual') {
      throw new AppError(400, "source must be 'crm_field', 'source_document' or 'manual'");
    }
    if (source === 'crm_field' && (!source_key?.trim() || !match_value?.trim())) {
      throw new AppError(400, "crm_field rules require source_key and match_value");
    }
    // Form must belong to this org.
    const form = await queryOne<{ id: string }>(
      'SELECT id FROM capture_forms WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
      [form_id, req.user!.organizationId]
    );
    if (!form) throw new AppError(404, 'Capture form not found');

    const rows = await query<CaptureFormRule>(
      `INSERT INTO capture_form_rules (organization_id, form_id, source, source_key, match_value, priority)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user!.organizationId, form_id, source, source_key?.trim() || null,
       match_value?.trim() || null, priority ?? 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

captureRouter.delete('/rules/:id', requireAdmin, async (req, res, next) => {
  try {
    const rows = await query<{ id: string }>(
      `UPDATE capture_form_rules SET is_active = false
        WHERE id = $1 AND organization_id = $2 AND is_active
        RETURNING id`,
      [req.params.id, req.user!.organizationId]
    );
    if (rows.length === 0) throw new AppError(404, 'Rule not found');
    res.json({ message: 'Rule removed' });
  } catch (err) {
    next(err);
  }
});

// ---------- Runs & answers ----------

interface AnswerWithField extends CaptureAnswer {
  label: string;
  answer_type: CaptureAnswerType;
  required: boolean;
  pii_class: CapturePiiClass;
  sort_order: number;
}

async function loadRunWithAnswers(organizationId: string, run: CaptureRun) {
  const answers = await query<AnswerWithField>(
    `SELECT ca.*, f.label, f.answer_type, f.required, f.pii_class, f.sort_order
       FROM capture_answers ca
       JOIN capture_form_fields f ON f.id = ca.field_id
      WHERE ca.run_id = $1
      ORDER BY f.sort_order`,
    [run.id]
  );
  const form = await queryOne<CaptureForm>(
    'SELECT * FROM capture_forms WHERE id = $1 AND organization_id = $2',
    [run.form_id, organizationId]
  );
  return { run, form, answers };
}

// The capture record for a journey: latest run + per-field answers.
captureRouter.get('/journeys/:journeyId', async (req, res, next) => {
  try {
    const run = await queryOne<CaptureRun>(
      `SELECT * FROM capture_runs
        WHERE journey_id = $1 AND organization_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [req.params.journeyId, req.user!.organizationId]
    );
    if (!run) return res.json({ run: null, form: null, answers: [] });
    res.json(await loadRunWithAnswers(req.user!.organizationId, run));
  } catch (err) {
    next(err);
  }
});

// Same for a single call (per-call capture orgs).
captureRouter.get('/calls/:callId', async (req, res, next) => {
  try {
    const run = await queryOne<CaptureRun>(
      `SELECT * FROM capture_runs
        WHERE call_id = $1 AND organization_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [req.params.callId, req.user!.organizationId]
    );
    if (!run) return res.json({ run: null, form: null, answers: [] });
    res.json(await loadRunWithAnswers(req.user!.organizationId, run));
  } catch (err) {
    next(err);
  }
});

// Manually run (or deliberately re-run) capture for a journey, optionally
// pinning a specific form — this is also how a needs_form run gets resolved.
// Admin-only, like journey re-scoring.
captureRouter.post('/journeys/:journeyId/run', requireAdmin, async (req, res, next) => {
  try {
    const { form_id } = req.body as { form_id?: string };
    const orgId = req.user!.organizationId;

    const journey = await queryOne<{ id: string; capture_form_id: string | null }>(
      'SELECT id, capture_form_id FROM journeys WHERE id = $1 AND organization_id = $2',
      [req.params.journeyId, orgId]
    );
    if (!journey) throw new AppError(404, 'Sale not found');

    const targetFormId = form_id ?? journey.capture_form_id;
    if (!targetFormId) throw new AppError(400, 'No capture form selected for this sale — pass form_id');

    const form = await getCaptureForm(orgId, targetFormId);
    if (!form) throw new AppError(404, 'Capture form not found');
    if (form.fields.length === 0) throw new AppError(400, 'Capture form has no fields');

    const runId = await withTransaction(async (tx) => {
      // A deliberate re-run replaces any previous run for this journey
      // (answers cascade away with their run).
      await tx.query('DELETE FROM capture_runs WHERE journey_id = $1 AND organization_id = $2', [journey.id, orgId]);
      await tx.query('UPDATE journeys SET capture_form_id = $1, updated_at = now() WHERE id = $2', [form.id, journey.id]);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO capture_runs (organization_id, journey_id, form_id, form_version, status)
         VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
        [orgId, journey.id, form.id, form.version]
      );
      return inserted[0]!.id;
    });

    await scoringQueue.add('capture', { runId }, { jobId: `capture-${runId}` });

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: 'capture_run.manual',
      entityType: 'journey',
      entityId: journey.id,
      metadata: { form_id: form.id, form_version: form.version, run_id: runId },
    });

    res.status(202).json({ run_id: runId, message: 'Capture run queued' });
  } catch (err) {
    next(err);
  }
});

// CSV export of a run's captured record — the "insurer asks, we pull it"
// artefact. Values for confirm-only fields export as their status, never a value.
captureRouter.get('/runs/:id/export.csv', async (req, res, next) => {
  try {
    const run = await queryOne<CaptureRun>(
      'SELECT * FROM capture_runs WHERE id = $1 AND organization_id = $2',
      [req.params.id, req.user!.organizationId]
    );
    if (!run) throw new AppError(404, 'Capture run not found');
    const { form, answers } = await loadRunWithAnswers(req.user!.organizationId, run);

    const esc = (v: string | null | undefined) => `"${(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Question', 'Asked', 'Answered', 'Answer', 'Result', 'Confidence', 'Evidence'].join(','),
      ...answers.map((a) =>
        [
          esc(a.label),
          a.asked ? 'yes' : 'no',
          a.answered ? 'yes' : 'no',
          esc(a.value_redacted || a.result === 'confirmed_only' ? '[confirmed — personal data]' : a.captured_value),
          esc(a.result),
          a.confidence != null ? String(a.confidence) : '',
          esc(a.evidence),
        ].join(',')
      ),
    ];

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'capture_run.export',
      entityType: 'capture_run',
      entityId: run.id,
      metadata: { form_name: form?.name ?? null },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="capture-${(form?.name ?? 'form').replace(/[^a-z0-9-_]+/gi, '_')}-${run.id.slice(0, 8)}.csv"`
    );
    res.send(lines.join('\r\n'));
  } catch (err) {
    next(err);
  }
});

// Coverage report: per-field asked/missed rates over completed runs in a date
// range — the "which questions are agents skipping" QC view.
captureRouter.get('/coverage', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const rows = await query<{
      form_id: string;
      form_name: string;
      field_id: string;
      label: string;
      required: boolean;
      total: string;
      asked: string;
      missed: string;
      manual_review: string;
    }>(
      `SELECT cf.id AS form_id, cf.name AS form_name, f.id AS field_id, f.label, f.required,
              COUNT(ca.id)::text AS total,
              COUNT(ca.id) FILTER (WHERE ca.asked)::text AS asked,
              COUNT(ca.id) FILTER (WHERE ca.result = 'missed')::text AS missed,
              COUNT(ca.id) FILTER (WHERE ca.result = 'manual_review')::text AS manual_review
         FROM capture_answers ca
         JOIN capture_runs r ON r.id = ca.run_id
         JOIN capture_form_fields f ON f.id = ca.field_id
         JOIN capture_forms cf ON cf.id = r.form_id
        WHERE r.organization_id = $1
          AND r.status = 'completed'
          AND r.completed_at >= now() - ($2 || ' days')::interval
        GROUP BY cf.id, cf.name, f.id, f.label, f.required, f.sort_order
        ORDER BY cf.name, f.sort_order`,
      [req.user!.organizationId, String(days)]
    );
    res.json({ days, data: rows });
  } catch (err) {
    next(err);
  }
});

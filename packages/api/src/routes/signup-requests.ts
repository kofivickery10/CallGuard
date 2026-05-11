import { Router } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { AppError } from '../middleware/errors.js';
import { recordAuditEvent } from '../services/audit.js';

export const signupRequestsRouter = Router();
signupRequestsRouter.use(authenticate);
signupRequestsRouter.use(requireAdmin);

const STATUSES = ['new', 'contacted', 'approved', 'rejected', 'churned'] as const;
type SignupStatus = typeof STATUSES[number];

interface SignupRequestRow {
  id: string;
  name: string;
  email: string;
  company: string;
  role: string | null;
  sector: string | null;
  expected_call_volume: string | null;
  message: string | null;
  status: SignupStatus;
  notes: string | null;
  approved_at: string | null;
  approved_by: string | null;
  invited_organization_id: string | null;
  ip_address: string | null;
  created_at: string;
  updated_at: string;
}

signupRequestsRouter.get('/', async (req, res, next) => {
  try {
    const status = (req.query.status as string | undefined) || '';
    const params: unknown[] = [];
    let where = '1=1';
    if (status && STATUSES.includes(status as SignupStatus)) {
      params.push(status);
      where = `status = $${params.length}`;
    }

    const rows = await query<SignupRequestRow>(
      `SELECT * FROM signup_requests
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT 200`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

signupRequestsRouter.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    if (!STATUSES.includes(status)) {
      throw new AppError(400, `Invalid status: ${status}`);
    }

    const existing = await queryOne<{ id: string; status: SignupStatus; email: string }>(
      'SELECT id, status, email FROM signup_requests WHERE id = $1',
      [req.params.id]
    );
    if (!existing) throw new AppError(404, 'Signup request not found');

    const setApproved = status === 'approved' && existing.status !== 'approved';

    await query(
      `UPDATE signup_requests SET
         status = $1,
         notes = COALESCE($2, notes),
         approved_at = CASE WHEN $3 THEN now() ELSE approved_at END,
         approved_by = CASE WHEN $3 THEN $4 ELSE approved_by END,
         updated_at = now()
       WHERE id = $5`,
      [status, typeof notes === 'string' ? notes : null, setApproved, req.user!.userId, existing.id]
    );

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'user.invite',
      entityType: 'user',
      entityId: existing.id,
      summary: `Signup request for ${existing.email}: ${existing.status} → ${status}`,
      metadata: { from: existing.status, to: status, email: existing.email },
      req,
    });

    res.json({ message: 'Status updated' });
  } catch (err) {
    next(err);
  }
});

signupRequestsRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await queryOne(
      'DELETE FROM signup_requests WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!result) throw new AppError(404, 'Signup request not found');
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

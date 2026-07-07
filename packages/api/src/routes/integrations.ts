import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { query, queryOne } from '../db/client.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errors.js';
import { encrypt } from '../services/crypto.js';
import { recordAuditEvent } from '../services/audit.js';
import {
  buildAuthorizeUrl,
  exchangeCodeAndStore,
  getConnectionRow,
  testConnection,
} from '../services/zoho.js';
import type {
  ZohoConnection,
  ZohoFieldMap,
  ZohoModule,
  ZohoRegion,
} from '@callguard/shared';

export const integrationsRouter = Router();

// Public columns only — never expose the encrypted secrets/tokens.
const ZOHO_PUBLIC_COLUMNS = `id, organization_id, dc_region, client_id, module,
  field_map, status, last_synced_at, last_error, created_at, updated_at`;

const DEFAULT_FIELD_MAP: ZohoFieldMap = {
  score: 'Compliance_Score',
  result: 'Compliance_Result',
  last_scored: 'Last_Scored',
  link: 'CallGuard_Link',
};

const VALID_REGIONS: ZohoRegion[] = ['eu', 'com', 'in', 'com.au', 'jp', 'ca'];
const VALID_MODULES: ZohoModule[] = ['Leads', 'Contacts'];

// ============================================================
// OAuth callback — PUBLIC. Zoho redirects the user's browser here with a code
// and the signed `state` we issued. Must be registered before the JWT-guarded
// admin router below so it isn't gated by `authenticate`.
// ============================================================

integrationsRouter.get('/zoho/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const fail = (message: string) =>
    res.redirect(`${config.appUrl}/integrations?zoho=error&message=${encodeURIComponent(message)}`);

  if (error) return fail(error);
  if (!code || !state) return fail('Missing code or state from Zoho');

  let organizationId: string;
  try {
    const decoded = jwt.verify(state, config.jwt.secret) as {
      organizationId: string;
      typ?: string;
    };
    if (decoded.typ !== 'zoho_oauth' || !decoded.organizationId) {
      return fail('Invalid authorization state');
    }
    organizationId = decoded.organizationId;
  } catch {
    return fail('Authorization link expired — try connecting again');
  }

  try {
    await exchangeCodeAndStore(organizationId, code);
  } catch (err) {
    return fail((err as Error).message);
  }

  void recordAuditEvent({
    organizationId,
    userId: null,
    actionType: 'zoho.connect',
    entityType: 'zoho_connection',
    summary: 'Completed Zoho CRM OAuth authorization',
  });

  res.redirect(`${config.appUrl}/integrations?zoho=connected`);
});

// ============================================================
// Zoho connection management (admin JWT auth)
// ============================================================

const zohoRouter = Router();
zohoRouter.use(authenticate);
zohoRouter.use(requireAdmin);

zohoRouter.get('/', async (req, res, next) => {
  try {
    const conn = await queryOne<ZohoConnection>(
      `SELECT ${ZOHO_PUBLIC_COLUMNS} FROM zoho_connections WHERE organization_id = $1`,
      [req.user!.organizationId]
    );
    res.json({ data: conn });
  } catch (err) {
    next(err);
  }
});

// Save credentials + config and return the Zoho consent URL. Re-saving sets the
// connection back to 'pending' so the admin must re-authorise (the client secret
// may have changed). Idempotent per org via the unique constraint.
zohoRouter.post('/', async (req, res, next) => {
  try {
    const orgId = req.user!.organizationId;
    const body = req.body as {
      dc_region?: string;
      client_id?: string;
      client_secret?: string;
      module?: string;
      field_map?: Partial<ZohoFieldMap>;
    };

    const region = (body.dc_region ?? 'eu') as ZohoRegion;
    if (!VALID_REGIONS.includes(region)) throw new AppError(400, 'Invalid dc_region');
    const module = (body.module ?? 'Leads') as ZohoModule;
    if (!VALID_MODULES.includes(module)) throw new AppError(400, 'Invalid module');
    if (!body.client_id) throw new AppError(400, 'client_id is required');

    const existing = await getConnectionRow(orgId);
    // On first save the secret is required; on edit it may be omitted to keep the
    // stored one — but then we can't re-run OAuth, so a re-save needs the secret.
    if (!body.client_secret) {
      throw new AppError(400, 'client_secret is required to (re)connect Zoho');
    }

    const fieldMap: ZohoFieldMap = { ...DEFAULT_FIELD_MAP, ...(body.field_map ?? {}) };
    // Zoho field API names are alphanumeric/underscore only. Catching an
    // empty or malformed entry here — rather than letting it reach Zoho —
    // turns a silent per-record write failure (a bad field_map key just
    // "succeeds" with nothing written, see services/zoho.ts) into an
    // immediate, actionable error at save time.
    for (const [key, value] of Object.entries(fieldMap)) {
      if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
        throw new AppError(400, `field_map.${key} must be a valid Zoho field API name`);
      }
    }

    await query(
      `INSERT INTO zoho_connections
         (organization_id, dc_region, client_id, client_secret_encrypted, module,
          field_map, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT (organization_id) DO UPDATE SET
         dc_region               = EXCLUDED.dc_region,
         client_id               = EXCLUDED.client_id,
         client_secret_encrypted = EXCLUDED.client_secret_encrypted,
         module                  = EXCLUDED.module,
         field_map               = EXCLUDED.field_map,
         status                  = 'pending',
         refresh_token_encrypted = NULL,
         access_token_encrypted  = NULL,
         token_expires_at        = NULL,
         last_error              = NULL,
         updated_at              = now()`,
      [orgId, region, body.client_id, encrypt(body.client_secret), module, JSON.stringify(fieldMap)]
    );

    void recordAuditEvent({
      organizationId: orgId,
      userId: req.user!.userId,
      actionType: existing ? 'zoho.update' : 'zoho.connect',
      entityType: 'zoho_connection',
      summary: `${existing ? 'Updated' : 'Configured'} Zoho CRM connection (${module}, ${region})`,
      metadata: { module, dc_region: region },
      req,
    });

    // Signed, short-lived state the public callback verifies to recover the org.
    const state = jwt.sign(
      { organizationId: orgId, typ: 'zoho_oauth' },
      config.jwt.secret,
      { expiresIn: '10m' }
    );
    const authorizeUrl = buildAuthorizeUrl({ region, clientId: body.client_id, state });
    res.status(201).json({ authorize_url: authorizeUrl });
  } catch (err) {
    next(err);
  }
});

// Re-issue a consent URL for an already-saved connection (e.g. reconnect after a
// revoked token) without resubmitting the secret.
zohoRouter.get('/authorize', async (req, res, next) => {
  try {
    const conn = await getConnectionRow(req.user!.organizationId);
    if (!conn) throw new AppError(404, 'No Zoho connection configured');
    const state = jwt.sign(
      { organizationId: req.user!.organizationId, typ: 'zoho_oauth' },
      config.jwt.secret,
      { expiresIn: '10m' }
    );
    res.json({
      authorize_url: buildAuthorizeUrl({
        region: conn.dc_region,
        clientId: conn.client_id,
        state,
      }),
    });
  } catch (err) {
    next(err);
  }
});

zohoRouter.post('/test', async (req, res, next) => {
  try {
    const result = await testConnection(req.user!.organizationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

zohoRouter.delete('/', async (req, res, next) => {
  try {
    const deleted = await queryOne<{ id: string }>(
      `DELETE FROM zoho_connections WHERE organization_id = $1 RETURNING id`,
      [req.user!.organizationId]
    );
    if (!deleted) throw new AppError(404, 'No Zoho connection to disconnect');

    void recordAuditEvent({
      organizationId: req.user!.organizationId,
      userId: req.user!.userId,
      actionType: 'zoho.disconnect',
      entityType: 'zoho_connection',
      summary: 'Disconnected Zoho CRM',
      req,
    });
    res.json({ message: 'Zoho disconnected' });
  } catch (err) {
    next(err);
  }
});

integrationsRouter.use('/zoho', zohoRouter);

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate, requireAdmin, authenticateApiKey } from '../middleware/auth.js';
import { apiKeyLimiter } from '../middleware/rate-limits.js';
import { query, queryOne } from '../db/client.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errors.js';
import { encrypt } from '../services/crypto.js';
import { recordAuditEvent } from '../services/audit.js';
import { normalizePhone, pickField } from '../services/ingestion.js';
import { ingestionQueue } from '../jobs/queue.js';
import {
  buildAuthorizeUrl,
  exchangeCodeAndStore,
  getConnectionRow,
  testConnection,
  verifyInboundSaleSignature,
} from '../services/zoho.js';
import type {
  ZohoConnection,
  ZohoFieldMap,
  ZohoQAFieldMap,
  ZohoModule,
  ZohoRegion,
} from '@callguard/shared';

export const integrationsRouter = Router();

// Public columns only — never expose the encrypted secrets/tokens.
const ZOHO_PUBLIC_COLUMNS = `id, organization_id, dc_region, client_id, module,
  field_map, sale_phone_field, qa_module, qa_field_map,
  sale_module, policies_related_list, policy_product_field, policies_module, sale_trigger_enabled,
  status, last_synced_at, last_error, created_at, updated_at,
  (inbound_secret_encrypted IS NOT NULL) AS inbound_configured`;

const DEFAULT_FIELD_MAP: ZohoFieldMap = {
  score: 'Compliance_Score',
  result: 'Compliance_Result',
  last_scored: 'Last_Scored',
  link: 'CallGuard_Link',
};

const DEFAULT_QA_FIELD_MAP: ZohoQAFieldMap = {
  score: 'AI_Call_Score',
  client_name: 'Name',
  customer_lookup: 'Client',
  notes: '', // opt-in: set to a text field's API name to write the summary
  agent: '', // opt-in: set to a text field's API name to write the agent name
};

const VALID_REGIONS: ZohoRegion[] = ['eu', 'com', 'in', 'com.au', 'jp', 'ca'];
const VALID_MODULES: ZohoModule[] = ['Leads', 'Contacts'];

// How long the sale trigger waits before assembling the journey, so a close
// call whose CloudTalk "Call Ended" webhook lands just after the sale is still
// captured and included. Comfortably covers the seconds-scale gap between a
// call ending and its capture webhook arriving.
const SALE_TRIGGER_GRACE_SECONDS = 90;

// How long assemble-journey will keep re-checking the CRM for the "Policies
// Sold" related record before giving up and letting score-journey infer the
// products from the transcript. Covers the tenant-reported "no more than an
// hour" gap between the sale record and its policies, with buffer.
const MAX_PRODUCT_WAIT_MS = 75 * 60 * 1000;

// Zoho field/module API names are alphanumeric/underscore only. Catching a
// malformed one here — rather than letting it reach Zoho — turns a silent
// per-record write failure (see services/zoho.ts) into an actionable save-time error.
function assertValidZohoApiName(label: string, value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new AppError(400, `${label} must be a valid Zoho API name`);
  }
}

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
// POST /api/integrations/zoho/sale-trigger (X-API-Key auth)
// The sale-trigger webhook (spec §9): fires when a deal/record is marked as
// a sale in Zoho (a CRM Workflow Rule -> Webhook action, configured by the
// tenant with the CallGuard API key as a custom header — same auth pattern
// as the CloudTalk ingestion webhook). Carries the customer phone number;
// assembles and scores that customer's journey.
// Also mounted at POST /webhooks/zoho (see app.ts) to match the spec's path.
// ============================================================

export async function handleZohoSaleTrigger(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
): Promise<void> {
  try {
    const orgId = req.user!.organizationId;
    const body = (req.body || {}) as Record<string, unknown>;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(body));

    const conn = await getConnectionRow(orgId);
    if (!conn) throw new AppError(404, 'No Zoho connection configured for this organization');

    const signatureHeader = req.headers['x-callguard-zoho-signature'] as string | undefined;
    if (!verifyInboundSaleSignature(conn, rawBody, signatureHeader)) {
      throw new AppError(401, 'Invalid or missing sale-trigger signature');
    }

    // Observability: log every delivery + the payload keys, so it's visible in
    // the logs whether Zoho is actually calling us and with what (keys only, no
    // PII values).
    console.log(`[Zoho] sale-trigger received (org ${orgId}) keys=[${Object.keys(body).join(',')}]`);

    const rawPhone = body[conn.sale_phone_field];
    if (typeof rawPhone !== 'string' || !rawPhone.trim()) {
      console.log(`[Zoho] sale-trigger ignored: no '${conn.sale_phone_field}' field in payload`);
      res.status(202).json({ status: 'ignored', reason: `no ${conn.sale_phone_field} field in payload` });
      return;
    }
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      console.log(`[Zoho] sale-trigger ignored: could not normalise "${rawPhone}"`);
      res.status(202).json({ status: 'ignored', reason: 'could not normalise phone number' });
      return;
    }

    // Defer assembly by a short grace delay so a close call whose CloudTalk
    // "Call Ended" webhook lands a beat after the sale still gets captured and
    // included in the journey. The customer lookup + assembly run in the job
    // (after the delay), so a sale that fires before any call was captured
    // isn't lost to an early "no calls on file" — the delay gives capture time
    // to arrive. assembleJourney is idempotent, so a Zoho retry that enqueues a
    // second job just reuses the in-flight journey.
    const recordId = typeof body.id === 'string' ? body.id : null;
    // Zoho workflows label the customer's name differently depending on how the
    // webhook was built (our documented `client_name`, or a raw module field
    // like Name / Full_Name / Last_Name). Accept the common variants so the QA
    // record gets a real name rather than "Unknown" when the workflow wasn't set
    // up with the exact `client_name` key.
    const clientName = pickField(body, [
      'client_name', 'Client_Name',
      'Full_Name', 'full_name', 'Name', 'name',
      'contact_name', 'Contact_Name', 'customer_name', 'Customer_Name',
      'Last_Name', 'last_name',
    ]);
    // Product-aware scoring: if the org has the "Policies Sold" related-list
    // mapping configured and the sale carried a record id, give assemble-journey
    // a deadline to poll the CRM for the products before scoring. Otherwise
    // omit it and assembly proceeds without product resolution.
    const productResolutionConfigured = !!(
      conn.sale_module && conn.policies_related_list && conn.policy_product_field
    );
    const productDeadlineAt =
      productResolutionConfigured && recordId ? Date.now() + MAX_PRODUCT_WAIT_MS : undefined;

    // Snapshot the payload's scalar fields so capture-form resolution rules
    // (capture_form_rules, source='crm_field' — e.g. an Insurer/Provider field
    // routing to a question set) can be evaluated when capture starts at
    // scoring time, long after this webhook payload is gone. Scalars only,
    // size-capped: this is routing context, not a data store.
    const triggerContext: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (Object.keys(triggerContext).length >= 40) break;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const str = String(value).slice(0, 200);
        if (str.trim()) triggerContext[key.slice(0, 100)] = str;
      }
    }

    await ingestionQueue.add(
      'assemble-journey',
      { organizationId: orgId, phone, recordId, clientName, productDeadlineAt, triggerContext },
      {
        delay: SALE_TRIGGER_GRACE_SECONDS * 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      }
    );

    console.log(`[Zoho] sale-trigger accepted: phone=${phone} recordId=${recordId ?? 'none'} client=${clientName ?? 'none'}`);
    res.status(202).json({ status: 'accepted', phone });
  } catch (err) {
    next(err);
  }
}

integrationsRouter.post('/zoho/sale-trigger', authenticateApiKey, apiKeyLimiter, handleZohoSaleTrigger);

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
      sale_phone_field?: string;
      qa_module?: string | null;
      qa_field_map?: Partial<ZohoQAFieldMap>;
      sale_module?: string | null;
      policies_related_list?: string | null;
      policy_product_field?: string | null;
      policies_module?: string | null;
      inbound_secret?: string;
      sale_trigger_enabled?: boolean;
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
    for (const [key, value] of Object.entries(fieldMap)) {
      assertValidZohoApiName(`field_map.${key}`, value);
    }

    const salePhoneField = body.sale_phone_field ?? 'Phone';
    assertValidZohoApiName('sale_phone_field', salePhoneField);

    const qaModule = body.qa_module?.trim() || null;
    if (qaModule) assertValidZohoApiName('qa_module', qaModule);

    const qaFieldMap: ZohoQAFieldMap = { ...DEFAULT_QA_FIELD_MAP, ...(body.qa_field_map ?? {}) };
    if (qaModule) {
      for (const [key, value] of Object.entries(qaFieldMap)) {
        // Empty = not configured (e.g. the optional notes field) — skip it.
        if (!value) continue;
        assertValidZohoApiName(`qa_field_map.${key}`, value);
      }
    }

    // Product-aware scoring config (all optional). Each is a Zoho API name when
    // set; blank/absent clears it. Product resolution only runs when all three
    // are set (see the sale-trigger handler and services/zoho.ts fetchSaleProducts).
    const saleModule = body.sale_module?.trim() || null;
    if (saleModule) assertValidZohoApiName('sale_module', saleModule);
    const policiesRelatedList = body.policies_related_list?.trim() || null;
    if (policiesRelatedList) assertValidZohoApiName('policies_related_list', policiesRelatedList);
    const policyProductField = body.policy_product_field?.trim() || null;
    if (policyProductField) assertValidZohoApiName('policy_product_field', policyProductField);
    const policiesModule = body.policies_module?.trim() || null;
    if (policiesModule) assertValidZohoApiName('policies_module', policiesModule);

    await query(
      `INSERT INTO zoho_connections
         (organization_id, dc_region, client_id, client_secret_encrypted, module,
          field_map, sale_phone_field, qa_module, qa_field_map,
          sale_module, policies_related_list, policy_product_field, policies_module,
          inbound_secret_encrypted, sale_trigger_enabled, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
       ON CONFLICT (organization_id) DO UPDATE SET
         dc_region               = EXCLUDED.dc_region,
         client_id               = EXCLUDED.client_id,
         client_secret_encrypted = EXCLUDED.client_secret_encrypted,
         module                  = EXCLUDED.module,
         field_map               = EXCLUDED.field_map,
         sale_phone_field        = EXCLUDED.sale_phone_field,
         qa_module               = EXCLUDED.qa_module,
         qa_field_map            = EXCLUDED.qa_field_map,
         sale_module             = EXCLUDED.sale_module,
         policies_related_list   = EXCLUDED.policies_related_list,
         policy_product_field    = EXCLUDED.policy_product_field,
         policies_module         = EXCLUDED.policies_module,
         inbound_secret_encrypted = COALESCE(EXCLUDED.inbound_secret_encrypted, zoho_connections.inbound_secret_encrypted),
         sale_trigger_enabled    = EXCLUDED.sale_trigger_enabled,
         status                  = 'pending',
         refresh_token_encrypted = NULL,
         access_token_encrypted  = NULL,
         token_expires_at        = NULL,
         last_error              = NULL,
         updated_at              = now()`,
      [
        orgId,
        region,
        body.client_id,
        encrypt(body.client_secret),
        module,
        JSON.stringify(fieldMap),
        salePhoneField,
        qaModule,
        JSON.stringify(qaFieldMap),
        saleModule,
        policiesRelatedList,
        policyProductField,
        policiesModule,
        body.inbound_secret ? encrypt(body.inbound_secret) : null,
        body.sale_trigger_enabled ?? false,
      ]
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

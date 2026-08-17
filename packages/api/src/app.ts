import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { pool } from './db/client.js';
import { getRedis, readWorkerHeartbeat } from './services/redis.js';
import { errorHandler } from './middleware/errors.js';
import {
  globalLimiter,
  authLimiter,
  publicFormLimiter,
  twoFactorLimiter,
  emailCodeLimiter,
  feedbackConfirmLimiter,
} from './middleware/rate-limits.js';
import { authRouter } from './routes/auth.js';
import { twoFactorRouter } from './routes/two-factor.js';
import { scorecardRouter } from './routes/scorecards.js';
import { callRouter } from './routes/calls.js';
import { dashboardRouter } from './routes/dashboard.js';
import { agentRouter } from './routes/agents.js';
import { kbRouter } from './routes/kb.js';
import { ingestionRouter, handleCloudTalkWebhook } from './routes/ingestion.js';
import { integrationsRouter, handleZohoSaleTrigger } from './routes/integrations.js';
import { journeysRouter } from './routes/journeys.js';
import { reviewRouter } from './routes/review.js';
import { authenticateApiKey } from './middleware/auth.js';
import { apiKeyLimiter } from './middleware/rate-limits.js';
import { alertsRouter } from './routes/alerts.js';
import { breachesRouter } from './routes/breaches.js';
import { complianceDocsRouter } from './routes/compliance-docs.js';
import { adminShareRouter, publicShareRouter } from './routes/share.js';
import { publicRouter } from './routes/public.js';
import { organizationRouter } from './routes/organization.js';
import { insightsRouter } from './routes/insights.js';
import { auditRouter } from './routes/audit.js';
import { supportRouter } from './routes/support.js';
import { streamRouter } from './routes/stream.js';
import { superadminRouter } from './routes/superadmin.js';
import { announcementsRouter } from './routes/announcements.js';
import { customersRouter } from './routes/customers.js';
import { captureRouter } from './routes/capture.js';
import { reconciliationRouter } from './routes/reconciliation.js';
import { feedbackRouter, publicFeedbackRouter } from './routes/journey-feedback.js';
import { usersRouter } from './routes/users.js';
import { productsRouter } from './routes/products.js';
import { boardPackRouter } from './routes/board-pack.js';

const app = express();

// Client traffic flows Cloudflare -> nginx -> app (two proxy hops). Trust both
// so req.ip resolves to the real client IP rather than a proxy. Override with
// TRUST_PROXY_HOPS if the deployment chain changes.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 2));

// Security headers. In production Cloudflare handles TLS so HSTS is set there
// too, but we emit it from the app as belt-and-braces for direct connections.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          'https://*.anthropic.com',
          'https://*.deepgram.com',
          'wss:', // WebSocket for live streaming
        ],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind inline styles
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    // HSTS: 1 year, include subdomains
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
    },
  })
);

// CORS: browser-originated traffic only (diallers use API key auth, not CORS).
// ALLOWED_ORIGINS env var is the canonical source — set it in production:
//   ALLOWED_ORIGINS=https://app.callguardai.co.uk,https://admin.callguardai.co.uk
// The production fallback below prevents a missing env var from silently
// blocking all browser traffic; update it when domains change.
const PROD_ORIGINS = [
  'https://app.callguardai.co.uk',
  'https://admin.callguardai.co.uk',
];
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3001'];

const isProd = process.env.NODE_ENV === 'production';

const rawOrigins = process.env.ALLOWED_ORIGINS;
const allowedOrigins: string[] = rawOrigins
  ? rawOrigins.split(',').map((o) => o.trim()).filter(Boolean)
  : isProd
    ? PROD_ORIGINS
    : DEV_ORIGINS;

// In dev the Vite servers may land on any localhost port (5173/5174/5175…),
// so accept any localhost/127.0.0.1 origin. Production stays on the allowlist.
const devLocalhost = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin (server-to-server, curl, health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (!isProd && devLocalhost.test(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  })
);

// Capture the raw request body alongside the parsed JSON so inbound webhook
// signatures (CloudTalk, Zoho sale trigger) can be verified against the exact
// bytes sent — re-serializing req.body would not byte-for-byte match what the
// sender HMAC'd.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

// Zoho's plain workflow Webhook action posts its module parameters as
// application/x-www-form-urlencoded, not JSON — so the sale-trigger receiver
// (routes/integrations.ts) would see an empty body under express.json alone.
// Parse form-encoded bodies too, capturing rawBody the same way so any HMAC
// signature check still verifies against the exact bytes sent.
app.use(
  express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);


app.use(globalLimiter);

// Liveness: process is up and serving. Cheap, no dependencies — for load
// balancers that just need "is the port answering".
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: actually checks the dependencies the app can't run without —
// Postgres, Redis, and a live worker heartbeat. Returns 503 if any is down so
// an uptime monitor pages before customers notice calls aren't processing.
app.get('/api/health/ready', async (_req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await pool.query('SELECT 1');
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: (err as Error).message };
  }

  try {
    const pong = await getRedis().ping();
    checks.redis = { ok: pong === 'PONG' };
  } catch (err) {
    checks.redis = { ok: false, detail: (err as Error).message };
  }

  try {
    const beat = await readWorkerHeartbeat();
    if (!beat) {
      checks.worker = { ok: false, detail: 'no heartbeat (worker down or never started)' };
    } else {
      const ageMs = Date.now() - new Date(beat).getTime();
      // Heartbeat is written every 30s; allow 2.5× before calling it stale.
      checks.worker = ageMs < 75_000
        ? { ok: true, detail: `last beat ${Math.round(ageMs / 1000)}s ago` }
        : { ok: false, detail: `stale heartbeat (${Math.round(ageMs / 1000)}s ago)` };
    }
  } catch (err) {
    checks.worker = { ok: false, detail: (err as Error).message };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Strict limits must be registered before the routers they protect.
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/2fa/login/email-code', emailCodeLimiter);
app.use('/api/auth/2fa/login/verify', twoFactorLimiter);
app.use('/api/public/demo-requests', publicFormLimiter);
// Unauthenticated: the adviser confirming feedback may have no login at all, so
// the token is the credential. A whole office can share one NAT egress IP and
// mail-security gateways prefetch links, so this uses its own, looser bucket
// rather than the public-form limiter.
app.use('/api/feedback', feedbackConfirmLimiter);

// 2FA routes mount under /api/auth/2fa — registered before the catch-all auth
// router so its paths take precedence.
app.use('/api/auth/2fa', twoFactorRouter);
app.use('/api/auth', authRouter);
app.use('/api/scorecards', scorecardRouter);
app.use('/api/calls', callRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/agents', agentRouter);
app.use('/api/kb', kbRouter);
app.use('/api/ingestion', ingestionRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/breaches', breachesRouter);
app.use('/api/compliance-docs', complianceDocsRouter);
app.use('/api/calls/:id/share-links', adminShareRouter);
app.use('/api/public/shared-calls', publicShareRouter);
app.use('/api/public', publicRouter);
app.use('/api/organization', organizationRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/audit-log', auditRouter);
app.use('/api/support', supportRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/customers', customersRouter);
app.use('/api/journeys', journeysRouter);
app.use('/api/board-pack', boardPackRouter);
app.use('/api/capture', captureRouter);
app.use('/api/reconciliation', reconciliationRouter);
// publicFeedbackRouter MUST be mounted before the bare-`/api` feedbackRouter
// below: both would otherwise match a `/api/feedback/<token>` request, and
// whichever is mounted first wins. feedbackRouter is mounted at the bare
// `/api` prefix (it has no /feedback route of its own; its paths live under
// /journeys/:journeyId/feedback) so that unmatched requests fall through —
// which is also why its auth must stay per-route rather than router-level.
app.use('/api/feedback', publicFeedbackRouter);
app.use('/api', feedbackRouter);
app.use('/api/review-items', reviewRouter);
app.use('/api/users', usersRouter);
app.use('/api/products', productsRouter);
app.use('/api/announcements', announcementsRouter);
app.use('/v1', streamRouter);

// Spec-literal webhook aliases: the same handlers as
// /api/ingestion/cloudtalk and /api/integrations/zoho/sale-trigger, mounted
// at the top-level paths some integrators (and the system spec) expect,
// without exposing the rest of either router at /webhooks/*.
app.post('/webhooks/cloudtalk', authenticateApiKey, apiKeyLimiter, handleCloudTalkWebhook);
app.post('/webhooks/zoho', authenticateApiKey, apiKeyLimiter, handleZohoSaleTrigger);

// Serve React static build in production
if (process.env.NODE_ENV === 'production') {
  const webDist = path.resolve(__dirname, '../../web/dist');

  // Hashed build output: safe to cache forever, but a miss must 404 rather than
  // fall through to the SPA handler. Returning index.html for a stale
  // /assets/Page-<hash>.js request (a tab open across a deploy) serves HTML for
  // a module script; the browser rejects it on MIME grounds and the lazy route
  // renders a blank screen. A clean 404 lets the client reload into the new build.
  app.use('/assets', express.static(path.join(webDist, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }));
  app.use('/assets', (_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  app.use(express.static(webDist, { index: false }));

  app.get('*', (_req, res) => {
    // index.html is the manifest of current chunk hashes — it must always be
    // revalidated, or a cached copy keeps requesting the previous build's files.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use(errorHandler);

export { app };

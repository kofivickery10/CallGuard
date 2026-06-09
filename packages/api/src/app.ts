import express from 'express';
import cors from 'cors';
import path from 'path';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { scorecardRouter } from './routes/scorecards.js';
import { callRouter } from './routes/calls.js';
import { dashboardRouter } from './routes/dashboard.js';
import { agentRouter } from './routes/agents.js';
import { kbRouter } from './routes/kb.js';
import { ingestionRouter } from './routes/ingestion.js';
import { alertsRouter } from './routes/alerts.js';
import { breachesRouter } from './routes/breaches.js';
import { complianceDocsRouter } from './routes/compliance-docs.js';
import { adminShareRouter, publicShareRouter } from './routes/share.js';
import { publicRouter } from './routes/public.js';
import { organizationRouter } from './routes/organization.js';
import { insightsRouter } from './routes/insights.js';
import { auditRouter } from './routes/audit.js';
import { supportRouter } from './routes/support.js';
import { adminRouter } from './routes/admin.js';
import { streamRouter } from './routes/stream.js';

const app = express();

// Client traffic flows Cloudflare -> nginx -> app (two proxy hops). Trust both
// so req.ip resolves to the real client IP rather than a proxy. Override with
// TRUST_PROXY_HOPS if the deployment chain changes.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 2));

app.use(cors());
app.use(express.json());

// Rate-limit key: prefer Cloudflare's CF-Connecting-IP (set at the edge to the
// true client IP and not client-spoofable when traffic arrives via Cloudflare),
// falling back to the trusted req.ip. ipKeyGenerator normalises IPv6.
const clientIpKey = (req: Request): string => {
  const cf = req.headers['cf-connecting-ip'];
  const ip = (Array.isArray(cf) ? cf[0] : cf) || req.ip || '';
  return ipKeyGenerator(ip);
};

// Abuse / brute-force protection.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many requests. Please slow down and try again shortly.' },
});
// Tight bucket for credential endpoints (login / register).
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many attempts. Please wait a minute and try again.' },
});
// Tight bucket for the unauthenticated public form.
const publicFormLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { message: 'Too many submissions. Please try again shortly.' },
});

app.use(globalLimiter);

// API routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Strict limits must be registered before the routers they protect.
app.use('/api/auth/login', authLimiter);
// Unauthenticated, credential-adjacent endpoints: invite token oracle + bcrypt on accept.
app.use('/api/auth/invite', authLimiter);
app.use('/api/auth/accept-invite', authLimiter);
app.use('/api/public/demo-requests', publicFormLimiter);

app.use('/api/auth', authRouter);
app.use('/api/scorecards', scorecardRouter);
app.use('/api/calls', callRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/agents', agentRouter);
app.use('/api/kb', kbRouter);
app.use('/api/ingestion', ingestionRouter);
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
app.use('/api/admin', adminRouter);
app.use('/v1', streamRouter);

// Serve React static build in production
if (process.env.NODE_ENV === 'production') {
  const webDist = path.resolve(__dirname, '../../web/dist');
  app.use(express.static(webDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use(errorHandler);

export { app };

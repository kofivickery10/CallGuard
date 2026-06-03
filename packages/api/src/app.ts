import express from 'express';
import cors from 'cors';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
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
import { streamRouter } from './routes/stream.js';

const app = express();

// Behind nginx (and Cloudflare). Trust one proxy hop so req.ip and the rate
// limiter key on the real client IP, not the proxy's.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Abuse / brute-force protection.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down and try again shortly.' },
});
// Tight bucket for credential endpoints (login / register).
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please wait a minute and try again.' },
});
// Tight bucket for the unauthenticated public form.
const publicFormLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many submissions. Please try again shortly.' },
});

app.use(globalLimiter);

// API routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Strict limits must be registered before the routers they protect.
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
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

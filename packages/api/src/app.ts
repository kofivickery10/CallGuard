import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { errorHandler } from './middleware/errors.js';
import { globalLimiter, authLimiter, publicFormLimiter } from './middleware/rate-limits.js';
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
import { streamRouter } from './routes/stream.js';
import { superadminRouter } from './routes/superadmin.js';
import { customersRouter } from './routes/customers.js';
import { usersRouter } from './routes/users.js';

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
          'https://*.amazonaws.com', // S3
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

const rawOrigins = process.env.ALLOWED_ORIGINS;
const allowedOrigins: string[] = rawOrigins
  ? rawOrigins.split(',').map((o) => o.trim()).filter(Boolean)
  : process.env.NODE_ENV === 'production'
    ? PROD_ORIGINS
    : DEV_ORIGINS;

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no Origin (server-to-server, curl, health checks)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  })
);

app.use(express.json());


app.use(globalLimiter);

// API routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Strict limits must be registered before the routers they protect.
app.use('/api/auth/login', authLimiter);
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
app.use('/api/superadmin', superadminRouter);
app.use('/api/customers', customersRouter);
app.use('/api/users', usersRouter);
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

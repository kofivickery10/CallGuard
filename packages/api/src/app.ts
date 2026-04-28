import express from 'express';
import cors from 'cors';
import path from 'path';
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
import { streamRouter } from './routes/stream.js';

const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

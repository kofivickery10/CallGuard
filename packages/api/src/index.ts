import http from 'http';
import { config } from './config.js';
import { app } from './app.js';
import { attachStreamServer } from './services/stream-server.js';
import { pool } from './db/client.js';
import { closeRedis } from './services/redis.js';

// An unhandled rejection is usually a stray async handler that threw instead of
// calling next(err). Log and keep serving rather than take the API down for
// every tenant over one bad request.
process.on('unhandledRejection', (reason) => {
  console.error('[api] Unhandled rejection:', reason);
});

// An uncaught exception, by contrast, leaves the process in an undefined state
// (a half-finished write, a corrupted in-memory structure). Log, then exit so
// the process manager restarts a clean instance — serving traffic from a broken
// process for days is worse than a fast restart.
process.on('uncaughtException', (err) => {
  console.error('[api] Uncaught exception — exiting for a clean restart:', err);
  shutdown('uncaughtException', 1);
});

const server = http.createServer(app);
attachStreamServer(server);

server.listen(config.port, () => {
  console.log(`CallGuard AI API running on port ${config.port}`);
  // Tell PM2 (wait_ready) the instance is up so a rolling reload only cuts over
  // once the new process is actually listening.
  if (process.send) process.send('ready');
});

let shuttingDown = false;

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received — draining connections...`);

  // Stop accepting new connections, let in-flight requests finish, then release
  // the DB pool and Redis so the process exits cleanly instead of being killed.
  const forceExit = setTimeout(() => {
    console.error('[api] Drain timed out — forcing exit');
    process.exit(code || 1);
  }, 25_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end().catch((err) => console.error('[api] pool.end error:', err));
  await closeRedis();
  clearTimeout(forceExit);
  console.log('[api] Shutdown complete');
  process.exit(code);
}

// Handle both signals: PM2 sends SIGINT on reload/stop, orchestrators send SIGTERM.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

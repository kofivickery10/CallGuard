import http from 'http';
import { config } from './config.js';
import { app } from './app.js';
import { attachStreamServer } from './services/stream-server.js';

// Backstop: an unhandled rejection anywhere (a stray async middleware/handler
// that throws instead of calling next(err)) would otherwise crash the process
// on Node's default behaviour. Log and keep serving rather than take the API
// down for every other tenant over one bad request.
process.on('unhandledRejection', (reason) => {
  console.error('[api] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[api] Uncaught exception:', err);
});

const server = http.createServer(app);
attachStreamServer(server);

server.listen(config.port, () => {
  console.log(`CallGuard AI API running on port ${config.port}`);
});

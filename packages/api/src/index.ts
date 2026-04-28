import http from 'http';
import { config } from './config.js';
import { app } from './app.js';
import { attachStreamServer } from './services/stream-server.js';

const server = http.createServer(app);
attachStreamServer(server);

server.listen(config.port, () => {
  console.log(`CallGuard API running on port ${config.port}`);
});

// PM2 process definitions. Both processes trap SIGINT/SIGTERM and drain
// gracefully (see packages/api/src/index.ts and jobs/worker.ts); the timeouts
// here give them room to do so before PM2 sends SIGKILL.
module.exports = {
  apps: [
    {
      name: 'callguard-api',
      script: './packages/api/dist/index.js',
      instances: 1,
      // The API signals 'ready' once it is actually listening, so a rolling
      // reload only cuts traffic over to the new instance when it can serve.
      wait_ready: true,
      listen_timeout: 10000,
      // Allow the API to drain in-flight HTTP + WebSocket connections. Must
      // exceed the drain timeout in index.ts (25s).
      kill_timeout: 30000,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'callguard-worker',
      script: './packages/api/dist/jobs/worker.js',
      instances: 1,
      // A transcription/scoring job can be mid-flight on an external API call;
      // BullMQ's close() waits for it. Give it well over the worst-case job
      // latency (and exceed the worker's own 110s drain timeout) before SIGKILL.
      kill_timeout: 120000,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

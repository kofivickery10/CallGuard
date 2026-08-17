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
      // A crash loop (bad deploy, missing env var, etc.) should not retry
      // forever — that just hammers the DB/Redis connection pools and the
      // ops inbox with the same failure. PM2 counts restarts since the last
      // time the process stayed up for min_uptime; below that it counts
      // toward max_restarts and then PM2 stops trying and leaves it 'errored'
      // (visible via `pm2 status` / `pm2 jlist`) rather than looping silently.
      min_uptime: 10000,
      max_restarts: 10,
      // Back off between crash-loop restarts instead of hammering the process
      // straight back up (which is also what would exhaust the DB pool fastest
      // — see db/client.ts). Caps at 15s so a single blip still recovers fast.
      exp_backoff_restart_delay: 200,
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
      // Same crash-loop protection as the API (see above), but a slightly
      // longer min_uptime: the worker does more at boot (DB/Redis connect,
      // remote-guard check, SFTP + retention schedule registration) before it
      // is genuinely healthy, so a restart that dies during that window
      // shouldn't be judged on the API's shorter window.
      min_uptime: 15000,
      max_restarts: 10,
      exp_backoff_restart_delay: 200,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

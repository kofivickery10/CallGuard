module.exports = {
  apps: [
    {
      name: 'callguard-api',
      script: './packages/api/dist/index.js',
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'callguard-worker',
      script: './packages/api/dist/jobs/worker.js',
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

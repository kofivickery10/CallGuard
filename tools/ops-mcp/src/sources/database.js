/** CallGuard database metrics: counts and totals only, never call content. */
export default {
  id: 'database',
  title: 'CallGuard database metrics',
  env: [
    {
      name: 'OPS_DATABASE_URL',
      secret: true,
      description: 'Postgres URL for a read-only role. Never the app DATABASE_URL.',
    },
  ],
  register: null,
};

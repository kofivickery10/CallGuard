/** Anthropic usage and cost. */
export default {
  id: 'anthropic',
  title: 'Anthropic usage and cost',
  env: [
    {
      name: 'ANTHROPIC_ADMIN_API_KEY',
      secret: true,
      description: 'Admin API key; the usage and cost reports do not accept ordinary keys.',
    },
  ],
  register: null,
};

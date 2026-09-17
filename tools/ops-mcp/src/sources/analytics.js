/** Google Analytics 4 traffic. */
export default {
  id: 'analytics',
  title: 'Google Analytics 4',
  env: [
    {
      name: 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
      file: true,
      description: 'Same service account as Search Console, added as a Viewer on the property.',
    },
    { name: 'GA4_PROPERTY_ID', description: 'Numeric GA4 property ID.' },
  ],
  register: null,
};

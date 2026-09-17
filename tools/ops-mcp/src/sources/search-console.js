/** Google Search Console for callguardai.co.uk. */
export default {
  id: 'search-console',
  title: 'Google Search Console',
  env: [
    {
      name: 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
      file: true,
      description: 'Path to the service-account JSON key, stored outside the repo.',
    },
    { name: 'GSC_SITE_URL', description: 'sc-domain:callguardai.co.uk or https://callguardai.co.uk/' },
  ],
  register: null,
};

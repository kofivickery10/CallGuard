/** FCA Financial Services Register lookups. */
export default {
  id: 'fca-register',
  title: 'FCA Financial Services Register',
  env: [
    { name: 'FCA_API_EMAIL', description: 'The email the Register API key was issued to.' },
    { name: 'FCA_API_KEY', secret: true, description: 'Register API key; the same pair as the root .env.' },
  ],
  register: null,
};

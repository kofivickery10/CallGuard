/** Companies House prospect checks. */
export default {
  id: 'companies-house',
  title: 'Companies House',
  env: [{ name: 'COMPANIES_HOUSE_API_KEY', secret: true, description: 'Companies House public data API key.' }],
  register: null,
};

/** Deepgram usage. */
export default {
  id: 'deepgram',
  title: 'Deepgram usage',
  env: [
    {
      name: 'DEEPGRAM_USAGE_API_KEY',
      secret: true,
      description: 'A key limited to reading usage, separate from the transcription key.',
    },
    { name: 'DEEPGRAM_PROJECT_ID', description: 'The Deepgram project CallGuard transcribes under.' },
  ],
  register: null,
};

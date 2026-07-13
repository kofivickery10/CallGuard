import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    // Source uses NodeNext-style `.js` import specifiers that actually point at
    // `.ts` files. Let Vitest resolve them to the TypeScript sources.
    extensions: ['.ts', '.js', '.json'],
  },
});

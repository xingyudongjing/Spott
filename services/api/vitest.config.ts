import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/*.integration.spec.ts', '**/node_modules/**', '**/dist/**'],
  },
});

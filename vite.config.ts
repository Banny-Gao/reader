import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  server: { host: '0.0.0.0', port: 5173 },
  build: { target: 'es2020', outDir: 'dist' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});

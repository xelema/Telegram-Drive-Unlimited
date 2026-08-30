import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types.ts'],
      thresholds: {
        statements: 41,
        branches: 48,
        functions: 38,
        lines: 43,
        'src/paypal.ts': {
          statements: 80,
          branches: 85,
          functions: 80,
          lines: 85,
        },
        'src/crypto.ts': {
          statements: 60,
          branches: 75,
          functions: 60,
          lines: 60,
        },
      },
    },
  },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.generated.ts',
        'src/components/dev/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      thresholds: {
        statements: 16,
        branches: 15,
        functions: 13,
        lines: 17,
        'src/context/SupporterContext.tsx': {
          statements: 55,
          branches: 45,
          functions: 40,
          lines: 60,
        },
        'src/services/supporterVisibility.ts': {
          statements: 88,
          branches: 90,
          functions: 80,
          lines: 85,
        },
        'src/services/settingsPersistence.ts': {
          statements: 90,
          branches: 95,
          functions: 80,
          lines: 90,
        },
        'src/services/transferQueuePolicy.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'src/components/shared/auth/AuthSteps.tsx': {
          statements: 80,
          branches: 70,
          functions: 75,
          lines: 80,
        },
      },
    },
  },
});

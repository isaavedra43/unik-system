import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

import { playwright } from '@vitest/browser-playwright';

const dirname =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests run against a REAL, disposable PostgreSQL database with every
 * migration applied (e.g. `unik_schema_check`). They only run when
 * UNIK_INTEGRATION_DATABASE_URL is set; otherwise every suite is skipped with a message.
 * The URL is exposed to the tests as DATABASE_URL so `@/lib/prisma` connects to it.
 */
const integrationDatabaseUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || undefined;
const integrationRequested = process.argv.some(
  (arg, index, argv) =>
    arg === '--project=integration' || (arg === 'integration' && argv[index - 1] === '--project')
);
const noticeScope = globalThis as typeof globalThis & { __unikIntegrationSkipNotice?: boolean };
if (integrationRequested && !integrationDatabaseUrl && !noticeScope.__unikIntegrationSkipNotice) {
  noticeScope.__unikIntegrationSkipNotice = true;
  console.warn(
    '[integration] UNIK_INTEGRATION_DATABASE_URL no está definida: se omiten los escenarios contra PostgreSQL. ' +
      'Apúntala a una base local y desechable con todas las migraciones aplicadas (p. ej. unik_schema_check).'
  );
}

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src'),
      'server-only': path.resolve(dirname, 'src/test/server-only.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          browser: { enabled: false },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.int.test.ts'],
          browser: { enabled: false },
          // One file at a time and tests in order: they share one real database.
          fileParallelism: false,
          // …and one RUN at a time: the global setup takes a PostgreSQL advisory
          // lock so two concurrent `npm run test:integration` wait for each other
          // instead of truncating each other's rows (see tests/integration/integration-lock.ts).
          globalSetup: ['./tests/integration/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          env: integrationDatabaseUrl
            ? {
                DATABASE_URL: integrationDatabaseUrl,
                UNIK_INTEGRATION_DATABASE_URL: integrationDatabaseUrl,
                // No background worker in tests: the suites drain jobs themselves.
                UNIK_JOB_WORKER_ENABLED: 'false',
                ZOHO_BOOKS_MOCK: 'false',
              }
            : {},
        },
      },
      {
        extends: true,
        plugins: [
          // The plugin will run tests for the stories defined in your Storybook config
          // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
          storybookTest({ configDir: path.join(dirname, '.storybook') }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

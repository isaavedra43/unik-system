import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StorybookConfig } from '@storybook/nextjs-vite';
import type { Plugin } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(dirname, '../src/app');

const EXPORTED_DECLARATION =
  /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g;
const EXPORTED_LIST = /export\s*\{([^}]*)\}/g;

/**
 * Server Actions (`'use server'`) never run in the browser: Next replaces the
 * module with a client reference when a client component imports it, but Vite
 * (Storybook) loads the real file and drags the whole server behind it —
 * sessions, Prisma, `node:crypto` — which explodes at import time and takes the
 * whole story file down with it (`Module "crypto" has been externalized`).
 *
 * This plugin keeps the module's SHAPE (its exported names, so the import
 * resolves) and drops its body. A story renders the component; it never calls a
 * server action, and if one is ever called the error says so instead of
 * silently doing nothing.
 */
function stubServerActions(): Plugin {
  return {
    name: 'unik-stub-server-actions',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.startsWith(APP_DIR) || !/\.(ts|tsx|js|jsx|mjs)$/.test(file)) return null;
      if (!/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*(['"])use server\1/.test(code)) return null;
      const names = new Set<string>();
      for (const match of code.matchAll(EXPORTED_DECLARATION)) names.add(match[1]);
      for (const match of code.matchAll(EXPORTED_LIST)) {
        for (const entry of match[1].split(',')) {
          const name = entry
            .trim()
            .split(/\s+as\s+/i)
            .pop()
            ?.trim();
          if (name && /^[A-Za-z0-9_$]+$/.test(name) && name !== 'default') names.add(name);
        }
      }
      const stubs = [...names]
        .map(
          (name) =>
            `export const ${name} = async () => { throw new Error('Server Action "${name}" no está disponible en Storybook'); };`
        )
        .join('\n');
      return { code: `${stubs}\n`, map: null };
    },
  };
}

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@chromatic-com/storybook',
    '@storybook/addon-vitest',
    '@storybook/addon-a11y',
    '@storybook/addon-docs',
    '@storybook/addon-mcp',
  ],
  framework: '@storybook/nextjs-vite',
  staticDirs: ['../public'],
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [stubServerActions(), ...(viteConfig.plugins ?? [])];
    return viteConfig;
  },
};
export default config;

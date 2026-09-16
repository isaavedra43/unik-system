import type { Preview } from '@storybook/nextjs-vite';
// Same order as src/app/layout.tsx: Tailwind + shadcn base first, then UNIK tokens and component CSS.
import '../src/styles/shadcn.css';
import '../src/app/globals.css';

const preview: Preview = {
  parameters: {
    // Toda la app es App Router: sin esto `useRouter()` de `next/navigation`
    // revienta con «invariant expected app router to be mounted».
    nextjs: { appDirectory: true },

    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo',
    },
  },
};

export default preview;

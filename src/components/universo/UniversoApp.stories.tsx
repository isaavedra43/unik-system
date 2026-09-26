import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import React from 'react';
import { Toaster } from 'sonner';
import '@/styles/shadcn.css';
import '@/app/globals.css';
import '@/styles/universo.css';
import { TooltipProvider } from '@/components/shadcn/tooltip';
import { UniversoApp } from './UniversoApp';
import { installUniversoMocks, storyUser, type MockOptions } from './stories/fixtures';

/**
 * UNIVERSO — full page with fixtures and a simulated API (no network, no real
 * data). `parameters.universo` picks the venue state; `globals.theme` or the
 * `dark` parameter renders the dark theme.
 */
function Frame({
  children,
  mocks,
  dark,
}: {
  children: React.ReactNode;
  mocks: MockOptions;
  dark: boolean;
}) {
  installUniversoMocks(mocks);
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', dark);
    try {
      window.localStorage.removeItem('unik.universo.layout.v1');
      window.localStorage.removeItem('unik.universo.model');
    } catch {
      /* ignore */
    }
  }
  return (
    <TooltipProvider delayDuration={200}>
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--unik-bg)',
        }}
      >
        {children}
      </div>
      <Toaster richColors position="top-right" />
    </TooltipProvider>
  );
}

const meta: Meta<typeof UniversoApp> = {
  title: 'Universo/App',
  component: UniversoApp,
  parameters: { layout: 'fullscreen' },
  args: { user: storyUser },
  decorators: [
    (Story, ctx) => (
      <Frame
        mocks={(ctx.parameters.universo as MockOptions) ?? {}}
        dark={Boolean(ctx.parameters.dark)}
      >
        <Story />
      </Frame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof UniversoApp>;

export const Conversacion: Story = {
  parameters: {
    universo: { venue: 'ready' },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: '/app/assistant', query: { c: 'c-demo' } },
    },
  },
};

export const ConversacionOscuro: Story = {
  parameters: {
    dark: true,
    universo: { venue: 'ready' },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: '/app/assistant', query: { c: 'c-demo' } },
    },
  },
};

export const Bienvenida: Story = {
  parameters: {
    universo: { venue: 'off' },
    nextjs: { appDirectory: true, navigation: { pathname: '/app/assistant', query: {} } },
  },
};

export const Trabajando: Story = {
  parameters: {
    universo: { venue: 'ready', liveTurn: true },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: '/app/assistant', query: { c: 'c-demo' } },
    },
  },
};

export const NavegadorArrancando: Story = {
  parameters: {
    universo: { venue: 'booting' },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: '/app/assistant', query: { c: 'c-demo' } },
    },
  },
};

export const Escritorio: Story = {
  parameters: {
    universo: { venue: 'desktop' },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: '/app/assistant', query: { c: 'c-demo' } },
    },
  },
};

/**
 * Voice mode against fixtures: /voice/transcribe returns a fixed question and
 * /voice/speak a soft tone instead of a real voice (no network, no real data).
 * With Chromium's fake microphone it runs a whole spoken turn end to end.
 */
export const VozSimulada: Story = {
  parameters: {
    universo: { venue: 'off', voice: {} },
    nextjs: { appDirectory: true, navigation: { pathname: '/app/assistant', query: {} } },
  },
};

/** The admin turned voice off: the panel says so and frees the microphone (no browser fallback). */
export const VozDesactivada: Story = {
  parameters: {
    universo: { venue: 'off', voice: { blocked: true } },
    nextjs: { appDirectory: true, navigation: { pathname: '/app/assistant', query: {} } },
  },
};

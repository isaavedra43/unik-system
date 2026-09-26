import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import React, { useEffect, useRef } from 'react';
import '@/styles/shadcn.css';
import '@/app/globals.css';
import '@/styles/universo.css';
import { TooltipProvider } from '@/components/shadcn/tooltip';
import { VoicePanelView, type VoicePanelViewProps } from './VoicePanel';
import type { VoiceLine, VoicePhase } from './useVoiceSession';

/** Voice mode states (fixtures — no microphone, no network). */

const LINES: VoiceLine[] = [
  { id: 1, role: 'user', text: '¿Cuánto vendimos ayer por sucursal?' },
  {
    id: 2,
    role: 'agent',
    text: 'Ayer vendiste 482 mil pesos en 31 pedidos. Norte lidera con 212 mil. Te dejé el detalle en el chat.',
  },
  { id: 3, role: 'user', text: 'Mándale el resumen a Luis por WhatsApp.' },
];

function Demo({
  phase,
  dark,
  muted = false,
  error = null,
  mode = 'server',
  transcript = false,
  width = 736,
}: {
  phase: VoicePhase;
  dark?: boolean;
  muted?: boolean;
  error?: string | null;
  mode?: 'server' | 'browser';
  transcript?: boolean;
  width?: number;
}) {
  const mic = useRef(0);
  const out = useRef(0);
  // A believable level so the orb moves in the story.
  useEffect(() => {
    let t = 0;
    const id = window.setInterval(() => {
      t += 0.3;
      const v = 0.35 + 0.3 * Math.abs(Math.sin(t));
      mic.current = phase === 'hearing' ? v / 6 : 0.004;
      out.current = phase === 'speaking' ? v : 0;
    }, 60);
    return () => window.clearInterval(id);
  }, [phase]);
  if (typeof document !== 'undefined')
    document.documentElement.classList.toggle('dark', Boolean(dark));
  const props: VoicePanelViewProps = {
    agentName: 'UNIK Central',
    phase,
    muted,
    error,
    lines: LINES,
    caption:
      phase === 'speaking'
        ? 'Ayer vendiste 482 mil pesos en 31 pedidos.'
        : phase === 'hearing'
          ? ''
          : '',
    mode,
    activity: phase === 'thinking' ? 'Consultando ventas' : null,
    micLevel: mic,
    outLevel: out,
    onMute: () => undefined,
    onInterrupt: () => undefined,
    onRetry: () => undefined,
    onClose: () => undefined,
    defaultTranscript: transcript,
  };
  return (
    <TooltipProvider>
      <div
        className="uv-scope"
        style={{
          background: 'var(--unik-surface)',
          color: 'var(--unik-text)',
          minHeight: '100dvh',
          padding: 24,
        }}
      >
        <div style={{ width: '100%', maxWidth: width, margin: '0 auto' }}>
          <VoicePanelView {...props} />
        </div>
      </div>
    </TooltipProvider>
  );
}

const meta: Meta = { title: 'Universo/Voz', parameters: { layout: 'fullscreen' } };
export default meta;
type Story = StoryObj;

export const Escuchando: Story = { render: () => <Demo phase="listening" /> };
export const OyendoTe: Story = { render: () => <Demo phase="hearing" /> };
export const Pensando: Story = { render: () => <Demo phase="thinking" /> };
export const Hablando: Story = { render: () => <Demo phase="speaking" /> };
export const HablandoOscuroConTranscripcion: Story = {
  render: () => <Demo phase="speaking" dark transcript />,
};
export const Silenciado: Story = { render: () => <Demo phase="listening" muted /> };
export const ErrorDeMicrofono: Story = {
  render: () => (
    <Demo phase="error" error="Permite el micrófono en tu navegador para hablar con el agente." />
  ),
};
export const ModoNavegadorMovil: Story = {
  render: () => <Demo phase="listening" mode="browser" width={375} />,
};

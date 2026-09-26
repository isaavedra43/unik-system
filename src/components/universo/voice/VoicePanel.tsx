'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, Captions, Hand, Mic, MicOff, PhoneOff, RotateCcw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';
import { cn } from '@/lib/utils';
import type { AgentInfo } from '../lib/types';
import { useVoiceSession, type VoiceLine, type VoicePhase } from './useVoiceSession';

/**
 * Voice mode, docked in the conversation (the chat stays visible: cards,
 * approvals and files appear as the agent talks). Same agent, same thread,
 * same tools — the words just go in and out as speech.
 */

function label(phase: VoicePhase, muted: boolean, agent: string, activity?: string | null) {
  switch (phase) {
    case 'starting':
      return 'Preparando el micrófono…';
    case 'listening':
      return muted ? 'Micrófono en silencio' : 'Te escucho';
    case 'hearing':
      return 'Escuchando…';
    case 'transcribing':
      return 'Entendiendo…';
    case 'thinking':
      return activity ?? 'Pensando…';
    case 'speaking':
      return `${agent} está hablando`;
    case 'error':
      return 'No se pudo usar la voz';
    default:
      return '';
  }
}

function IconBtn({
  label: text,
  onClick,
  children,
  pressed,
  tone,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  tone?: 'danger';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn('uv-voice-btn', tone === 'danger' && 'is-danger', pressed && 'is-on')}
          onClick={onClick}
          aria-label={text}
          aria-pressed={pressed}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
  );
}

export function VoicePanel({
  agent,
  send,
  streaming,
  content,
  activity,
  onClose,
}: {
  agent: AgentInfo;
  send: (text: string) => Promise<unknown> | void;
  streaming: boolean;
  content: string;
  activity?: string | null;
  onClose: () => void;
}) {
  const v = useVoiceSession({ send, streaming, content, activity });
  return (
    <VoicePanelView
      agentName={agent.name}
      phase={v.phase}
      muted={v.muted}
      error={v.error}
      lines={v.lines}
      caption={v.caption}
      mode={v.mode}
      activity={activity}
      micLevel={v.micLevel}
      outLevel={v.outLevel}
      onMute={v.toggleMute}
      onInterrupt={v.interrupt}
      onRetry={v.retry}
      onClose={onClose}
    />
  );
}

export interface VoicePanelViewProps {
  agentName: string;
  phase: VoicePhase;
  muted: boolean;
  error: string | null;
  lines: VoiceLine[];
  caption: string;
  mode: 'server' | 'browser';
  activity?: string | null;
  micLevel: React.MutableRefObject<number>;
  outLevel: React.MutableRefObject<number>;
  onMute: () => void;
  onInterrupt: () => void;
  onRetry: () => void;
  onClose: () => void;
  /** Stories: open with the transcript visible. */
  defaultTranscript?: boolean;
}

export function VoicePanelView({
  agentName,
  phase,
  muted,
  error,
  lines,
  caption,
  mode,
  activity,
  micLevel,
  outLevel,
  onMute,
  onInterrupt,
  onRetry,
  onClose,
  defaultTranscript = false,
}: VoicePanelViewProps) {
  const [showTranscript, setShowTranscript] = useState(defaultTranscript);
  const orbRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // The orb follows the voice that is sounding: the user's or the agent's.
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const p = phaseRef.current;
      const target =
        p === 'speaking'
          ? outLevel.current
          : p === 'hearing' || p === 'listening'
            ? micLevel.current * 6
            : 0;
      smooth += (Math.min(1, target) - smooth) * 0.25;
      orbRef.current?.style.setProperty('--lvl', smooth.toFixed(3));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [micLevel, outLevel]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, showTranscript]);

  // Esc ends the conversation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const lastUser = [...lines].reverse().find((l) => l.role === 'user');
  const sub =
    phase === 'speaking' || phase === 'hearing'
      ? caption
      : phase === 'thinking' || phase === 'transcribing'
        ? (lastUser?.text ?? '')
        : phase === 'listening' && !muted
          ? caption ||
            (mode === 'browser'
              ? 'Habla cuando quieras.'
              : 'Habla cuando quieras; puedes interrumpirme.')
          : '';

  return (
    <motion.section
      className={cn('uv-voice', `is-${phase}`, muted && 'is-muted')}
      role="region"
      aria-label="Conversación por voz"
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 14, scale: 0.98 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      {showTranscript && (
        <div className="uv-voice-transcript" ref={transcriptRef} aria-live="polite">
          {lines.length === 0 ? (
            <p className="uv-voice-empty">Aquí aparece lo que dicen los dos.</p>
          ) : (
            lines.map((l) => (
              <p key={l.id} className={cn('uv-voice-line', `is-${l.role}`)}>
                <strong>{l.role === 'user' ? 'Tú' : agentName}</strong>
                {l.text}
              </p>
            ))
          )}
        </div>
      )}
      <div className="uv-voice-bar">
        <div className="uv-voice-orb" ref={orbRef} aria-hidden="true">
          <i className="uv-voice-orb-ring" />
          <i className="uv-voice-orb-ring is-2" />
          <i className="uv-voice-orb-core" />
          <span className="uv-voice-orb-bars">
            <b />
            <b />
            <b />
            <b />
          </span>
        </div>
        <div className="uv-voice-status" aria-live="polite">
          <strong>{label(phase, muted, agentName, activity)}</strong>
          {sub && <span className="uv-voice-caption">{sub}</span>}
        </div>
        <div className="uv-voice-controls">
          {phase === 'speaking' && (
            <IconBtn label="Interrumpir" onClick={onInterrupt}>
              <Hand size={17} />
            </IconBtn>
          )}
          <IconBtn
            label={muted ? 'Activar micrófono' : 'Silenciar micrófono'}
            onClick={onMute}
            pressed={muted}
          >
            {muted ? <MicOff size={17} /> : <Mic size={17} />}
          </IconBtn>
          <IconBtn
            label={showTranscript ? 'Ocultar transcripción' : 'Ver transcripción'}
            onClick={() => setShowTranscript((s) => !s)}
            pressed={showTranscript}
          >
            <Captions size={17} />
          </IconBtn>
          <IconBtn label="Terminar y volver al chat (Esc)" onClick={onClose} tone="danger">
            <PhoneOff size={17} />
          </IconBtn>
        </div>
      </div>
      {error && (
        <div className="uv-voice-error" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button type="button" className="uv-link-btn" onClick={onRetry}>
            <RotateCcw size={12} /> Reintentar
          </button>
        </div>
      )}
      {mode === 'browser' && !error && (
        <p className="uv-voice-note">
          Voz del navegador (la del servidor no está disponible): espera a que termine de hablar
          para responder.
        </p>
      )}
    </motion.section>
  );
}

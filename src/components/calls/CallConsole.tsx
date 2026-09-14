'use client';

import React from 'react';
import {
  Bot,
  BotOff,
  Circle,
  CircleDot,
  Ear,
  Phone,
  PhoneForwarded,
  PhoneOff,
  UserPlus,
  Volume1,
} from 'lucide-react';
import type { VoiceCallDTO, VoiceSupervisionDTO } from '@/modules/voice/voice-service';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { LiveTimer } from './CallBadges';
import { callStartMs } from './calls-format';

type SupervisionMode = VoiceSupervisionDTO['mode'];

const SUPERVISION_MODES: Array<{
  key: SupervisionMode;
  label: string;
  icon: typeof Ear;
  hint: string;
}> = [
  {
    key: 'listen',
    label: 'Escuchar',
    icon: Ear,
    hint: 'Solo escuchas. Nadie en la llamada te oye.',
  },
  {
    key: 'whisper',
    label: 'Susurrar',
    icon: Volume1,
    hint: 'Pensado para que solo el agente te oiga. Por ahora te escuchan todos los participantes.',
  },
  {
    key: 'barge',
    label: 'Intervenir',
    icon: UserPlus,
    hint: 'Entras a la llamada y todos te oyen.',
  },
];

export interface CallConsoleProps {
  call: VoiceCallDTO;
  canUse: boolean;
  canSupervise: boolean;
  canControl: boolean;
  isParticipant: boolean;
  supervisionMode: SupervisionMode | null;
  stream: 'connecting' | 'open' | 'error';
  busy: string | null;
  onJoin: () => void;
  onToggleAi: () => void;
  onToggleRecording: () => void;
  onSupervise: (mode: SupervisionMode) => void;
  onEndSupervision: () => void;
  onTransfer: () => void;
  onEnd: () => void;
}

export function CallConsole({
  call,
  canUse,
  canSupervise,
  canControl,
  isParticipant,
  supervisionMode,
  stream,
  busy,
  onJoin,
  onToggleAi,
  onToggleRecording,
  onSupervise,
  onEndSupervision,
  onTransfer,
  onEnd,
}: CallConsoleProps) {
  const ringing = call.status === 'ringing';
  const aiOn = call.aiState === 'active';
  const recording = call.recordingState === 'recording';
  const currentMode = SUPERVISION_MODES.find((m) => m.key === supervisionMode);

  const aiTitle = aiOn
    ? call.aiMode === 'answer'
      ? 'Asistente de voz · activa'
      : 'Copiloto de IA · activo'
    : 'IA en pausa';
  const aiDescription = aiOn
    ? call.aiMode === 'answer'
      ? 'Atiende al cliente y transcribe la llamada.'
      : 'Transcribe y sugiere respuestas; nunca habla.'
    : `No transcribe, no sugiere y no habla. Al reanudar empieza la generación ${call.aiGeneration + 1}.`;

  return (
    <section className="calls-console" aria-label="Controles de la llamada">
      <div className="calls-console-top">
        <span className={`badge ${ringing ? 'badge-warning' : 'badge-success'}`}>
          <span className={cn('calls-dot', ringing && 'is-pulse')} aria-hidden="true" />
          {ringing ? 'Timbrando' : 'En curso'}
        </span>
        <span className={cn('calls-stream', `is-${stream}`)} aria-live="polite">
          <span className="calls-dot" aria-hidden="true" />
          {stream === 'open'
            ? 'Tiempo real'
            : stream === 'connecting'
              ? 'Conectando…'
              : 'Reconectando…'}
        </span>
        <LiveTimer since={callStartMs(call)} />
      </div>

      {canUse && !isParticipant ? (
        <Button
          full
          variant={ringing ? 'primary' : 'secondary'}
          onClick={onJoin}
          isLoading={busy === 'join'}
          icon={<Phone size={15} />}
        >
          {ringing ? 'Atender llamada' : 'Unirme a la llamada'}
        </Button>
      ) : null}

      {canControl ? (
        <div className="calls-switches">
          {call.aiState === 'off' ? (
            <div className="calls-switch-row">
              <span className="calls-switch-icon" aria-hidden="true">
                <BotOff size={16} />
              </span>
              <span className="calls-switch-text">
                <strong>IA apagada</strong>
                <span>Esta llamada entró sin IA. Se configura por línea en Telefonía.</span>
              </span>
            </div>
          ) : (
            <div className="calls-switch-row">
              <span
                className={cn('calls-switch-icon', aiOn ? 'is-ai' : 'is-paused')}
                aria-hidden="true"
              >
                {aiOn ? <Bot size={16} /> : <BotOff size={16} />}
              </span>
              <span className="calls-switch-text">
                <strong>{aiTitle}</strong>
                <span>{aiDescription}</span>
              </span>
              <button
                type="button"
                role="switch"
                className="calls-switch"
                aria-checked={aiOn}
                aria-label={aiOn ? 'Pausar IA' : 'Reanudar IA'}
                onClick={onToggleAi}
                disabled={busy === 'ai'}
              />
            </div>
          )}
          <div className="calls-switch-row">
            <span className={cn('calls-switch-icon', recording && 'is-rec')} aria-hidden="true">
              {recording ? <CircleDot size={16} /> : <Circle size={16} />}
            </span>
            <span className="calls-switch-text">
              <strong>{recording ? 'Grabando' : 'Grabación apagada'}</strong>
              <span>
                {recording
                  ? 'Se guarda en Archivos con acceso restringido.'
                  : 'Independiente de la IA: puedes grabar aunque la IA esté en pausa.'}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              className="calls-switch is-rec"
              aria-checked={recording}
              aria-label={recording ? 'Detener grabación' : 'Grabar'}
              onClick={onToggleRecording}
              disabled={busy === 'rec'}
            />
          </div>
        </div>
      ) : null}

      {canSupervise && !isParticipant ? (
        <div className="calls-sup">
          <div className="calls-sup-head">
            <span>Supervisar</span>
            {supervisionMode ? (
              <button
                type="button"
                className="calls-link"
                onClick={onEndSupervision}
                disabled={busy === 'sup-end'}
              >
                Dejar de supervisar
              </button>
            ) : null}
          </div>
          <div
            className="calls-seg calls-seg-fill"
            role="radiogroup"
            aria-label="Modo de supervisión"
          >
            {SUPERVISION_MODES.map((mode) => {
              const Icon = mode.icon;
              const loading = busy === `supervise-${mode.key}`;
              return (
                <button
                  key={mode.key}
                  type="button"
                  role="radio"
                  aria-checked={supervisionMode === mode.key}
                  onClick={() => supervisionMode !== mode.key && onSupervise(mode.key)}
                  disabled={Boolean(busy?.startsWith('supervise'))}
                >
                  {loading ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <Icon size={14} aria-hidden="true" />
                  )}
                  {mode.label}
                </button>
              );
            })}
          </div>
          <p className="calls-hint">
            {currentMode
              ? currentMode.hint
              : 'Elige cómo entrar. El agente lo ve y queda en la actividad de la llamada.'}
          </p>
        </div>
      ) : null}

      {canControl ? (
        <div className="calls-console-actions">
          <Button variant="secondary" icon={<PhoneForwarded size={14} />} onClick={onTransfer}>
            {call.aiMode === 'answer' ? 'Pasar a una persona' : 'Transferir'}
          </Button>
          <Button
            variant="danger"
            icon={<PhoneOff size={14} />}
            onClick={onEnd}
            isLoading={busy === 'end'}
          >
            Terminar
          </Button>
        </div>
      ) : null}
    </section>
  );
}

'use client';

import React from 'react';
import { Bot, BotOff, Clock, Ear, Headphones, Phone, PhoneCall } from 'lucide-react';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { AiBadge, LiveTimer, RecordingBadge } from './CallBadges';
import { callStartMs, callSubtitle, callTitle, handlerLabel, TYPE_LABEL } from './calls-format';

export type LiveQuickAction = 'answer' | 'listen' | 'pauseAi' | 'resumeAi';

export interface CallsLiveStripProps {
  calls: VoiceCallDTO[];
  loading: boolean;
  userId: string;
  canUse: boolean;
  canSupervise: boolean;
  selectedId: string | null;
  busyKey: string | null;
  onSelect: (id: string) => void;
  onQuick: (call: VoiceCallDTO, action: LiveQuickAction) => void;
}

export function CallsLiveStrip({
  calls,
  loading,
  userId,
  canUse,
  canSupervise,
  selectedId,
  busyKey,
  onSelect,
  onQuick,
}: CallsLiveStripProps) {
  if (loading && calls.length === 0) return null;

  if (calls.length === 0) {
    return (
      <section className="calls-live-empty" aria-label="Llamadas en vivo">
        <span className="calls-live-empty-icon" aria-hidden="true">
          <PhoneCall size={16} />
        </span>
        <p>
          <strong>Sin llamadas en vivo.</strong> Las que timbren o estén en curso aparecen aquí al
          momento.
        </p>
      </section>
    );
  }

  const ringing = calls.filter((c) => c.status === 'ringing').length;

  return (
    <section className="calls-live" aria-label="Llamadas en vivo">
      <header className="calls-section-head">
        <h2>En vivo</h2>
        <span className="calls-count">{calls.length}</span>
        {ringing > 0 ? (
          <span className="badge badge-warning" role="status">
            <span className="calls-dot is-pulse" aria-hidden="true" />
            {ringing} timbrando
          </span>
        ) : null}
      </header>
      <div className="calls-live-grid">
        {calls.map((call) => (
          <LiveTile
            key={call.id}
            call={call}
            userId={userId}
            canUse={canUse}
            canSupervise={canSupervise}
            selected={selectedId === call.id}
            busyKey={busyKey}
            onSelect={onSelect}
            onQuick={onQuick}
          />
        ))}
      </div>
    </section>
  );
}

function LiveTile({
  call,
  userId,
  canUse,
  canSupervise,
  selected,
  busyKey,
  onSelect,
  onQuick,
}: {
  call: VoiceCallDTO;
  userId: string;
  canUse: boolean;
  canSupervise: boolean;
  selected: boolean;
  busyKey: string | null;
  onSelect: (id: string) => void;
  onQuick: (call: VoiceCallDTO, action: LiveQuickAction) => void;
}) {
  const ringing = call.status === 'ringing';
  const title = callTitle(call, userId);
  const isParticipant = call.participants.some(
    (p) => p.userId === userId && p.role !== 'supervisor' && !p.leftAt
  );
  const isSupervising = call.supervisions.some((s) => s.supervisorUserId === userId);
  const busy = (action: LiveQuickAction) => busyKey === `${call.id}:${action}`;

  return (
    <article className={cn('calls-tile', ringing && 'is-ringing', selected && 'is-selected')}>
      <button
        type="button"
        className="calls-tile-hit"
        data-call-id={call.id}
        onClick={() => onSelect(call.id)}
        aria-label={`Ver llamada con ${title}`}
        aria-current={selected || undefined}
      />
      <div className="calls-tile-top">
        <span className={`badge ${ringing ? 'badge-warning' : 'badge-success'}`}>
          <span className={cn('calls-dot', ringing && 'is-pulse')} aria-hidden="true" />
          {ringing ? 'Timbrando' : 'En curso'}
        </span>
        <span className="calls-tile-line">
          {TYPE_LABEL[call.type]}
          {call.accountLabel ? ` · ${call.accountLabel}` : ''}
        </span>
        <LiveTimer since={callStartMs(call)} />
      </div>

      <div className="calls-tile-who">
        <strong title={title}>{title}</strong>
        <span className={call.contactName ? 'calls-mono' : undefined}>{callSubtitle(call)}</span>
      </div>

      <div className="calls-tile-meta">
        <span className="calls-tile-handler">
          {ringing ? (
            <Clock size={14} aria-hidden="true" />
          ) : (
            <Headphones size={14} aria-hidden="true" />
          )}
          {ringing ? 'Esperando' : handlerLabel(call, userId)}
        </span>
        {call.aiState !== 'off' ? <AiBadge call={call} /> : null}
        {call.recordingState === 'recording' ? <RecordingBadge call={call} /> : null}
        {call.supervisions.length > 0 ? (
          <span className="badge badge-warning">
            <Ear size={12} aria-hidden="true" /> {isSupervising ? 'Supervisando' : 'Supervisada'}
          </span>
        ) : null}
      </div>

      <div className="calls-tile-actions">
        {canUse && !isParticipant ? (
          <Button
            size="sm"
            variant={ringing ? 'primary' : 'secondary'}
            icon={<Phone size={14} />}
            isLoading={busy('answer')}
            onClick={() => onQuick(call, 'answer')}
          >
            {ringing ? 'Atender' : 'Unirme'}
          </Button>
        ) : null}
        {!ringing && canSupervise && !isParticipant && !isSupervising ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Ear size={14} />}
            isLoading={busy('listen')}
            onClick={() => onQuick(call, 'listen')}
          >
            Escuchar
          </Button>
        ) : null}
        {!ringing && isParticipant && call.aiState !== 'off' ? (
          call.aiState === 'active' ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<BotOff size={14} />}
              isLoading={busy('pauseAi')}
              onClick={() => onQuick(call, 'pauseAi')}
            >
              Pausar IA
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<Bot size={14} />}
              isLoading={busy('resumeAi')}
              onClick={() => onQuick(call, 'resumeAi')}
            >
              Reanudar IA
            </Button>
          )
        ) : null}
      </div>
    </article>
  );
}

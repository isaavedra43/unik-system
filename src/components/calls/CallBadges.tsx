'use client';

import React, { useEffect, useState } from 'react';
import {
  Bot,
  Circle,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Users,
} from 'lucide-react';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import { cn } from '@/lib/utils';
import { formatDuration, STATUS_LABEL } from './calls-format';

export function StatusBadge({ call }: { call: VoiceCallDTO }) {
  const status = STATUS_LABEL[call.status];
  return <span className={`badge ${status.badge}`}>{status.label}</span>;
}

export function AiBadge({ call }: { call: VoiceCallDTO }) {
  if (call.aiState === 'off') return <span className="badge badge-weak">IA apagada</span>;
  if (call.aiState === 'paused') return <span className="badge badge-warning">IA en pausa</span>;
  return (
    <span className="badge badge-info">
      <Bot size={12} aria-hidden="true" /> {call.aiMode === 'answer' ? 'IA atiende' : 'Copiloto'}
    </span>
  );
}

export function RecordingBadge({ call }: { call: VoiceCallDTO }) {
  if (call.recordingState === 'recording') {
    return (
      <span className="badge badge-danger">
        <Circle size={9} fill="currentColor" aria-hidden="true" /> Grabando
      </span>
    );
  }
  if (call.recordingObjectId) return <span className="badge badge-success">Grabación</span>;
  return <span className="badge badge-weak">Sin grabar</span>;
}

export function CallDirectionIcon({ call, className }: { call: VoiceCallDTO; className?: string }) {
  const missed = call.status === 'missed' || call.status === 'failed';
  const Icon =
    call.status === 'missed'
      ? PhoneMissed
      : call.status === 'failed'
        ? PhoneOff
        : call.type === 'internal'
          ? Users
          : call.type === 'inbound'
            ? PhoneIncoming
            : PhoneOutgoing;
  return (
    <span className={cn('calls-dir', missed && 'is-missed', className)} aria-hidden="true">
      <Icon size={15} />
    </span>
  );
}

/** Ticking m:ss counter; owns its interval so the page does not re-render every second. */
export function LiveTimer({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  return (
    <span className={cn('calls-timer', className)}>
      {formatDuration(Math.max(0, Math.floor((now - since) / 1000)))}
    </span>
  );
}

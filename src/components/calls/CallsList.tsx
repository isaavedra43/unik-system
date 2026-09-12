'use client';

import React from 'react';
import { Bot, Circle, Mic, PhoneIncoming, PhoneOutgoing, Users } from 'lucide-react';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';

export const STATUS_LABEL: Record<VoiceCallDTO['status'], { label: string; badge: string }> = {
  ringing: { label: 'Timbrando', badge: 'badge-warning' },
  active: { label: 'En curso', badge: 'badge-success' },
  ended: { label: 'Finalizada', badge: 'badge-weak' },
  failed: { label: 'Fallida', badge: 'badge-danger' },
  missed: { label: 'Perdida', badge: 'badge-danger' },
};

export const TYPE_LABEL: Record<VoiceCallDTO['type'], string> = {
  internal: 'Interna',
  inbound: 'Entrante',
  outbound: 'Saliente',
};

export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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
        <Circle size={10} fill="currentColor" aria-hidden="true" /> Grabando
      </span>
    );
  }
  if (call.recordingObjectId) return <span className="badge badge-success">Grabación</span>;
  return <span className="badge badge-weak">Sin grabar</span>;
}

function TypeIcon({ type }: { type: VoiceCallDTO['type'] }) {
  if (type === 'inbound') return <PhoneIncoming size={16} aria-hidden="true" />;
  if (type === 'outbound') return <PhoneOutgoing size={16} aria-hidden="true" />;
  return <Users size={16} aria-hidden="true" />;
}

export function CallsList({
  calls,
  selectedId,
  onSelect,
  loading,
  error,
}: {
  calls: VoiceCallDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}) {
  if (loading && calls.length === 0)
    return <div className="assistant-admin-loading">Cargando llamadas…</div>;
  if (error && calls.length === 0)
    return (
      <div className="alert alert-error" role="alert">
        {error}
      </div>
    );
  if (calls.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <Mic size={40} aria-hidden="true" />
        </div>
        <h3 className="empty-state-title">Sin llamadas</h3>
        <p>Aquí aparecerán tus llamadas internas, entrantes y salientes.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th scope="col">Tipo</th>
            <th scope="col">Con</th>
            <th scope="col">Estado</th>
            <th scope="col">Duración</th>
            <th scope="col">IA</th>
            <th scope="col">Grabación</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call) => {
            const others = call.participants
              .filter((p) => p.role !== 'supervisor' && p.role !== 'ai')
              .map(
                (p) =>
                  p.userName ??
                  (p.identity.startsWith('sip-') ? (call.externalNumber ?? 'Teléfono') : p.identity)
              );
            const status = STATUS_LABEL[call.status];
            return (
              <tr
                key={call.id}
                onClick={() => onSelect(call.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(call.id);
                  }
                }}
                tabIndex={0}
                aria-selected={selectedId === call.id}
                style={{
                  cursor: 'pointer',
                  background: selectedId === call.id ? 'var(--unik-surface-hover)' : undefined,
                }}
              >
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                    <TypeIcon type={call.type} /> {TYPE_LABEL[call.type]}
                  </span>
                </td>
                <td>{others.length ? others.join(', ') : (call.externalNumber ?? '—')}</td>
                <td>
                  <span className={`badge ${status.badge}`}>{status.label}</span>
                </td>
                <td>{formatDuration(call.durationSec)}</td>
                <td>
                  <AiBadge call={call} />
                </td>
                <td>
                  <RecordingBadge call={call} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Circle,
  Ear,
  Lightbulb,
  MessageSquareText,
  Mic,
  MicOff,
  PhoneForwarded,
  PhoneOff,
  Play,
  Square,
  UserPlus,
  Volume2,
} from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { TranscriptSegmentDTO, VoiceCallDTO } from '@/modules/voice/voice-service';
import type { IssuedToken } from '@/modules/voice/livekit-service';
import { Modal } from '@/components/ui/composite';
import { Button, FormField, Select } from '@/components/ui/primitives';
import { useCallStream, type CallStreamEvent } from './useCallStream';
import { CallRoom } from './CallRoom';
import { AiBadge, formatDuration, RecordingBadge, STATUS_LABEL, TYPE_LABEL } from './CallsList';

interface Suggestion {
  kind: 'answer' | 'question' | 'warning' | 'task';
  text: string;
}

const SUGGESTION_BADGE: Record<Suggestion['kind'], string> = {
  answer: 'badge-info',
  question: 'badge-default',
  warning: 'badge-warning',
  task: 'badge-success',
};

export interface CallDetailProps {
  user: CurrentUser;
  callId: string;
  canUse: boolean;
  canSupervise: boolean;
  initialToken: IssuedToken | null;
  onChanged: (call: VoiceCallDTO) => void;
}

export function CallDetail({
  callId,
  canUse,
  canSupervise,
  initialToken,
  onChanged,
  user,
}: CallDetailProps) {
  const [call, setCall] = useState<VoiceCallDTO | null>(null);
  const [segments, setSegments] = useState<TranscriptSegmentDTO[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [aiReplies, setAiReplies] = useState<Array<{ text: string; pending: string[] }>>([]);
  const [token, setToken] = useState<IssuedToken | null>(initialToken);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stream, setStream] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [manualText, setManualText] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/app/calls/api/calls/${callId}/transcript`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'No se pudo cargar la llamada');
        return;
      }
      const data = (await res.json()) as { call: VoiceCallDTO; segments: TranscriptSegmentDTO[] };
      setCall(data.call);
      setSegments(data.segments);
      setError(null);
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    setLoading(true);
    setSegments([]);
    setSuggestions([]);
    setAiReplies([]);
    setToken(initialToken);
    load();
  }, [callId, load, initialToken]);

  const onEvent = useCallback(
    (event: CallStreamEvent) => {
      const payload = event.payload;
      if (payload.call && typeof payload.call === 'object') {
        const next = payload.call as VoiceCallDTO;
        setCall(next);
        onChanged(next);
      }
      switch (event.type) {
        case 'transcript_segment': {
          const seg = payload.segment as TranscriptSegmentDTO | undefined;
          if (seg)
            setSegments((prev) => (prev.some((s) => s.id === seg.id) ? prev : [...prev, seg]));
          break;
        }
        case 'copilot_suggestion':
          setSuggestions(
            Array.isArray(payload.suggestions) ? (payload.suggestions as Suggestion[]) : []
          );
          break;
        case 'ai_reply':
          setAiReplies((prev) => [
            ...prev.slice(-9),
            {
              text: String(payload.text ?? ''),
              pending: Array.isArray(payload.pendingApprovals)
                ? (payload.pendingApprovals as Array<{ summary: string }>).map((p) => p.summary)
                : [],
            },
          ]);
          break;
        case 'recording_ready':
        case 'summary_ready':
        case 'transcript_ready':
          load();
          break;
        default:
          break;
      }
    },
    [load, onChanged]
  );
  useCallStream(callId, onEvent, setStream);

  async function post(
    path: string,
    body?: unknown,
    label?: string
  ): Promise<Record<string, unknown> | null> {
    setBusy(label ?? path);
    setError(null);
    try {
      const res = await fetch(`/app/calls/api/calls/${callId}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError((data.error as string) ?? 'Operación no permitida');
        return null;
      }
      if (data.call) {
        setCall(data.call as VoiceCallDTO);
        onChanged(data.call as VoiceCallDTO);
      }
      return data;
    } catch {
      setError('Error de red');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function join() {
    const data = await post('/token', undefined, 'join');
    if (data?.token) setToken(data.token as IssuedToken);
    await load();
  }

  async function supervise(mode: 'listen' | 'whisper' | 'barge') {
    const data = await post('/supervise', { mode }, `supervise-${mode}`);
    if (data?.token) setToken(data.token as IssuedToken);
  }

  async function openTransfer() {
    setTransferOpen(true);
    if (users.length === 0) {
      const res = await fetch('/app/calls/api/directory');
      if (res.ok) {
        const data = (await res.json()) as { users: Array<{ id: string; name: string }> };
        setUsers(data.users);
        if (data.users[0]) setTransferTo(data.users[0].id);
      }
    }
  }

  async function sendManualTurn() {
    const text = manualText.trim();
    if (!text) return;
    const data = await post('/ai/turn', { text }, 'turn');
    if (data && data.discarded === false) setManualText('');
    if (data && data.discarded === true)
      setError(`La IA descartó el turno (${String(data.reason)})`);
  }

  const isActive = call?.status === 'active' || call?.status === 'ringing';
  const isParticipant = useMemo(
    () => Boolean(call?.participants.some((p) => p.userId === user.id && p.role !== 'supervisor')),
    [call, user.id]
  );
  const isSupervising = useMemo(
    () => Boolean(call?.supervisions.some((s) => s.supervisorUserId === user.id)),
    [call, user.id]
  );
  const canControl = Boolean(
    call &&
    (user.isSuperAdmin ||
      (canUse && isParticipant) ||
      (canSupervise && isSupervising) ||
      canSupervise)
  );

  if (loading && !call) return <div className="assistant-admin-loading">Cargando llamada…</div>;
  if (!call) {
    return (
      <div className="alert alert-error" role="alert">
        {error ?? 'Llamada no disponible'}
      </div>
    );
  }
  const status = STATUS_LABEL[call.status];

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h2 className="card-title">
              {TYPE_LABEL[call.type]} {call.externalNumber ? `· ${call.externalNumber}` : ''}
            </h2>
            <p className="card-subtitle">
              {new Date(call.createdAt).toLocaleString('es-MX')} · duración{' '}
              {formatDuration(call.durationSec)} ·{' '}
              <span className="text-muted" aria-live="polite">
                {stream === 'open'
                  ? 'en vivo'
                  : stream === 'connecting'
                    ? 'conectando…'
                    : 'sin conexión en vivo'}
              </span>
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span className={`badge ${status.badge}`}>{status.label}</span>
            <AiBadge call={call} />
            <RecordingBadge call={call} />
            {call.supervisions.length > 0 ? (
              <span className="badge badge-warning">
                <Ear size={12} aria-hidden="true" /> Supervisada (
                {call.supervisions.map((s) => s.mode).join(', ')})
              </span>
            ) : null}
            {call.mock ? <span className="badge badge-weak">simulado</span> : null}
          </div>
        </div>

        {error ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : null}

        <div
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
          aria-label="Controles de la llamada"
        >
          {canUse && isActive && !isParticipant ? (
            <Button size="sm" onClick={join} isLoading={busy === 'join'} icon={<Mic size={14} />}>
              Unirme / atender
            </Button>
          ) : null}
          {canControl && isActive ? (
            <>
              {call.aiState === 'active' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => post('/ai/pause', undefined, 'ai')}
                  isLoading={busy === 'ai'}
                  icon={<MicOff size={14} />}
                >
                  Pausar IA
                </Button>
              ) : call.aiState === 'paused' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => post('/ai/resume', undefined, 'ai')}
                  isLoading={busy === 'ai'}
                  icon={<Bot size={14} />}
                >
                  Reanudar IA
                </Button>
              ) : null}
              {call.recordingState === 'recording' ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => post('/recording', { on: false }, 'rec')}
                  isLoading={busy === 'rec'}
                  icon={<Square size={14} />}
                >
                  Detener grabación
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => post('/recording', { on: true }, 'rec')}
                  isLoading={busy === 'rec'}
                  icon={<Circle size={14} />}
                >
                  Grabar
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={openTransfer}
                icon={<PhoneForwarded size={14} />}
              >
                Transferir a humano
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => post('/end', undefined, 'end')}
                isLoading={busy === 'end'}
                icon={<PhoneOff size={14} />}
              >
                Terminar
              </Button>
            </>
          ) : null}
          {canSupervise && isActive ? (
            isSupervising ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => post('/supervise/end', undefined, 'sup-end')}
                isLoading={busy === 'sup-end'}
              >
                Dejar de supervisar
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => supervise('listen')}
                  isLoading={busy === 'supervise-listen'}
                  icon={<Ear size={14} />}
                >
                  Escuchar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => supervise('whisper')}
                  isLoading={busy === 'supervise-whisper'}
                  icon={<Volume2 size={14} />}
                >
                  Susurrar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => supervise('barge')}
                  isLoading={busy === 'supervise-barge'}
                  icon={<UserPlus size={14} />}
                >
                  Intervenir
                </Button>
              </>
            )
          ) : null}
        </div>

        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {call.participants.map((p) => (
            <span key={p.id} className={`badge ${p.leftAt ? 'badge-weak' : 'badge-default'}`}>
              {p.role === 'ai' ? 'IA' : p.role === 'supervisor' ? 'Supervisor' : p.role}:{' '}
              {p.userName ?? p.identity}
              {p.leftAt ? ' (salió)' : ''}
            </span>
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <MessageSquareText size={16} aria-hidden="true" /> Transcripción
            </h3>
            {call.aiState !== 'active' ? (
              <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                La transcripción está detenida mientras la IA no está activa.
              </span>
            ) : null}
          </div>
          <div
            style={{ maxHeight: 360, overflowY: 'auto', display: 'grid', gap: '0.5rem' }}
            aria-live="polite"
          >
            {segments.length === 0 ? (
              <p className="text-muted">Aún no hay transcripción.</p>
            ) : (
              segments.map((s) => (
                <div key={s.id} style={{ display: 'grid', gap: '0.1rem' }}>
                  <span className="text-muted" style={{ fontSize: '0.7rem' }}>
                    {s.speakerIdentity.startsWith('ai-')
                      ? 'IA'
                      : s.speakerIdentity.startsWith('user-')
                        ? 'Agente'
                        : s.speakerIdentity === 'recording'
                          ? 'Grabación'
                          : 'Cliente'}{' '}
                    · {formatDuration(Math.floor(s.startMs / 1000))} ·{' '}
                    {new Date(s.createdAt).toLocaleString('es-MX', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span>{s.text}</span>
                </div>
              ))
            )}
          </div>
          {canControl && isActive && call.aiMode === 'answer' && call.aiState === 'active' ? (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <input
                className="input"
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Texto del cliente (prueba del ciclo STT→LLM→TTS)"
                aria-label="Texto del cliente para la IA"
              />
              <Button
                size="sm"
                onClick={sendManualTurn}
                isLoading={busy === 'turn'}
                disabled={!manualText.trim()}
              >
                Enviar a la IA
              </Button>
            </div>
          ) : null}
          {aiReplies.length > 0 ? (
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.35rem' }}>
              {aiReplies.map((r, i) => (
                <div key={i} className="alert alert-info">
                  <strong>IA:</strong> {r.text}
                  {r.pending.length > 0 ? (
                    <div className="text-muted" style={{ fontSize: '0.75rem' }}>
                      Pendiente de autorización humana: {r.pending.join('; ')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'grid', gap: '1rem', alignContent: 'start' }}>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Lightbulb size={16} aria-hidden="true" /> Copiloto
              </h3>
            </div>
            {call.aiState !== 'active' ? (
              <p className="text-muted">El copiloto está en pausa.</p>
            ) : call.aiMode === 'answer' ? (
              <p className="text-muted">
                La IA está atendiendo esta llamada; las sugerencias aplican a llamadas humanas.
              </p>
            ) : suggestions.length === 0 ? (
              <p className="text-muted">
                Las sugerencias aparecerán conforme avance la conversación.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1rem', display: 'grid', gap: '0.4rem' }}>
                {suggestions.map((s, i) => (
                  <li key={i}>
                    <span
                      className={`badge ${SUGGESTION_BADGE[s.kind]}`}
                      style={{ marginRight: '0.4rem' }}
                    >
                      {s.kind === 'warning'
                        ? 'Requiere autorización'
                        : s.kind === 'task'
                          ? 'Tarea'
                          : s.kind === 'question'
                            ? 'Pregunta'
                            : 'Respuesta'}
                    </span>
                    {s.text}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <CallRoom token={token} />

          {call.recordingObjectId ? (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  <Play size={16} aria-hidden="true" /> Grabación
                </h3>
                {call.recordingExpiresAt ? (
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                    Vence {new Date(call.recordingExpiresAt).toLocaleDateString('es-MX')}
                  </span>
                ) : null}
              </div>
              <audio
                controls
                preload="metadata"
                src={`/app/files/api/objects/${call.recordingObjectId}/content`}
                style={{ width: '100%' }}
                aria-label="Reproducir grabación de la llamada"
              />
            </div>
          ) : null}

          {call.summary ? (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Resumen</h3>
              </div>
              <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{call.summary}</p>
            </div>
          ) : null}
        </div>
      </div>

      <Modal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Transferir a un humano"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTransferOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={async () => {
                const data = await post('/transfer', { userId: transferTo }, 'transfer');
                if (data) setTransferOpen(false);
              }}
              disabled={!transferTo}
              isLoading={busy === 'transfer'}
            >
              Transferir
            </Button>
          </>
        }
      >
        <FormField
          label="Usuario destino"
          htmlFor="transfer-user"
          help="La IA deja de hablar; puede seguir como copiloto."
        >
          <Select
            id="transfer-user"
            value={transferTo}
            onChange={(e) => setTransferTo(e.target.value)}
          >
            {users.length === 0 ? <option value="">Cargando…</option> : null}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </FormField>
      </Modal>
    </div>
  );
}

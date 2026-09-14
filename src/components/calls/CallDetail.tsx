'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CircleCheck,
  CornerDownRight,
  Copy,
  Lightbulb,
  MessageSquareText,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Sparkles,
  X,
} from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { TranscriptSegmentDTO, VoiceCallDTO } from '@/modules/voice/voice-service';
import type { IssuedToken } from '@/modules/voice/livekit-service';
import { Modal } from '@/components/ui/composite';
import { Avatar, Button, FormField, IconButton, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useCallStream, type CallStreamEvent } from './useCallStream';
import { CallRoom } from './CallRoom';
import { CallConsole } from './CallConsole';
import { CallDirectionIcon, LiveTimer } from './CallBadges';
import {
  buildActivity,
  callNumberLabel,
  callStartMs,
  callTitle,
  dayLabel,
  externalNumberOf,
  formatDuration,
  handlerLabel,
  isAiIdentity,
  isLiveCall,
  parseSummary,
  participantName,
  ROLE_LABEL,
  speakerKind,
  speakerLabel,
  timeLabel,
  TYPE_LABEL,
} from './calls-format';

interface Suggestion {
  kind: 'answer' | 'question' | 'warning' | 'task';
  text: string;
}

const SUGGESTION_META: Record<Suggestion['kind'], { badge: string; label: string }> = {
  answer: { badge: 'badge-info', label: 'Respuesta' },
  question: { badge: 'badge-default', label: 'Pregunta' },
  warning: { badge: 'badge-warning', label: 'Requiere autorización' },
  task: { badge: 'badge-success', label: 'Seguimiento' },
};

type TabKey = 'summary' | 'transcript' | 'recording' | 'people' | 'activity';

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];

export interface CallDetailProps {
  user: CurrentUser;
  callId: string;
  canUse: boolean;
  canSupervise: boolean;
  initialToken: IssuedToken | null;
  onChanged: (call: VoiceCallDTO) => void;
  onClose: () => void;
  onCallback?: (call: VoiceCallDTO) => void;
}

export function CallDetail({
  callId,
  canUse,
  canSupervise,
  initialToken,
  onChanged,
  onClose,
  onCallback,
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
  const [tab, setTab] = useState<TabKey | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [copied, setCopied] = useState<'number' | 'summary' | null>(null);
  const [rate, setRate] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});

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
    setCall(null);
    setSegments([]);
    setSuggestions([]);
    setAiReplies([]);
    setToken(initialToken);
    setTab(null);
    setEndOpen(false);
    setTransferOpen(false);
    pendingSeek.current = null;
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
        case 'call_ended':
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
    await load();
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

  async function copy(text: string, what: 'number' | 'summary') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError('No se pudo copiar al portapapeles');
    }
  }

  function seekTo(ms: number) {
    pendingSeek.current = ms / 1000;
    setTab('recording');
  }

  const isActive = call ? isLiveCall(call) : false;
  const isParticipant = useMemo(
    () => Boolean(call?.participants.some((p) => p.userId === user.id && p.role !== 'supervisor')),
    [call, user.id]
  );
  const supervisionMode =
    call?.supervisions.find((s) => s.supervisorUserId === user.id)?.mode ?? null;
  const canControl = Boolean(
    call && (user.isSuperAdmin || (canUse && isParticipant) || canSupervise)
  );

  const tabs = useMemo(() => {
    if (!call) return [] as Array<{ key: TabKey; label: string; count?: number }>;
    const list: Array<{ key: TabKey; label: string; count?: number }> = [];
    if (isLiveCall(call)) {
      list.push({ key: 'transcript', label: 'Transcripción', count: segments.length });
      list.push({
        key: 'people',
        label: 'Participantes',
        count: call.participants.filter((p) => !p.leftAt).length,
      });
    } else if (call.status === 'ended') {
      list.push({ key: 'summary', label: 'Resumen' });
      list.push({ key: 'transcript', label: 'Transcripción', count: segments.length });
      if (call.recordingObjectId) list.push({ key: 'recording', label: 'Grabación' });
    }
    list.push({ key: 'activity', label: 'Actividad' });
    return list;
  }, [call, segments.length]);
  const activeTab: TabKey = tabs.some((t) => t.key === tab)
    ? (tab as TabKey)
    : (tabs[0]?.key ?? 'activity');

  useEffect(() => {
    if (activeTab !== 'recording' || pendingSeek.current === null) return;
    const audio = audioRef.current;
    if (!audio) return;
    const target = pendingSeek.current;
    const apply = () => {
      audio.currentTime = target;
      pendingSeek.current = null;
      void audio.play().catch(() => undefined);
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener('loadedmetadata', apply, { once: true });
  }, [activeTab]);

  function onTabKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((t) => t.key === activeTab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.key);
    tabRefs.current[next.key]?.focus();
  }

  if (loading && !call) {
    return (
      <div className="calls-d-skeleton" aria-busy="true" aria-label="Cargando llamada">
        <span className="calls-skel is-title" />
        <span className="calls-skel" style={{ width: '45%' }} />
        <span className="calls-skel is-block" />
        <span className="calls-skel" style={{ width: '80%' }} />
        <span className="calls-skel" style={{ width: '64%' }} />
      </div>
    );
  }
  if (!call) {
    return (
      <div className="calls-d-skeleton">
        <div className="alert alert-error" role="alert">
          {error ?? 'Llamada no disponible'}
        </div>
        <div>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    );
  }

  const title = callTitle(call, user.id);
  const number = callNumberLabel(call);
  const rawNumber = externalNumberOf(call);
  const canCallBack = Boolean(onCallback && rawNumber);
  const summary = parseSummary(call.summary);

  return (
    <div className="calls-detail-inner">
      <header className="calls-d-head">
        <div className="calls-d-title">
          <CallDirectionIcon call={call} className="is-lg" />
          <div className="calls-d-title-text">
            <p className="calls-d-kicker">
              {TYPE_LABEL[call.type]}
              {call.accountLabel ? ` · ${call.accountLabel}` : ''}
            </p>
            <h2>{title}</h2>
            <div className="calls-d-sub">
              {number && call.contactName ? <span className="calls-mono">{number}</span> : null}
              {!call.contactName && number ? <span>Sin contacto registrado</span> : null}
              {rawNumber ? (
                <IconButton
                  className="calls-d-copy"
                  onClick={() => copy(rawNumber, 'number')}
                  aria-label="Copiar número"
                  title={copied === 'number' ? 'Copiado' : 'Copiar número'}
                >
                  {copied === 'number' ? <Check size={14} /> : <Copy size={14} />}
                </IconButton>
              ) : null}
              {call.mock ? <span className="badge badge-weak">simulado</span> : null}
            </div>
          </div>
          <IconButton className="calls-d-close" onClick={onClose} aria-label="Cerrar detalle">
            <X size={18} />
          </IconButton>
        </div>

        <dl className="calls-kv">
          <div>
            <dt>Atendió</dt>
            <dd title={handlerLabel(call, user.id)}>{handlerLabel(call, user.id)}</dd>
          </div>
          <div>
            <dt>{isActive ? 'Inicio' : dayLabel(call.createdAt)}</dt>
            <dd className="calls-mono">
              {timeLabel(isActive ? new Date(callStartMs(call)).toISOString() : call.createdAt)}
            </dd>
          </div>
          <div>
            <dt>Duración</dt>
            <dd className="calls-mono">
              {isActive ? (
                <LiveTimer since={callStartMs(call)} />
              ) : (
                formatDuration(call.durationSec)
              )}
            </dd>
          </div>
          <div>
            <dt>Transcripción</dt>
            <dd>
              {segments.length > 0
                ? `${segments.length} ${segments.length === 1 ? 'frase' : 'frases'}`
                : 'Sin frases'}
            </dd>
          </div>
        </dl>

        {call.status === 'ended' && canCallBack ? (
          <div className="calls-d-quick">
            <Button
              size="sm"
              variant="secondary"
              icon={<PhoneOutgoing size={14} />}
              onClick={() => onCallback?.(call)}
            >
              Devolver llamada
            </Button>
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="alert alert-error calls-d-alert" role="alert">
          {error}
        </div>
      ) : null}

      {call.status === 'missed' || call.status === 'failed' ? (
        <div className="calls-callout" role="status">
          {call.status === 'missed' ? (
            <PhoneMissed size={18} aria-hidden="true" />
          ) : (
            <PhoneOff size={18} aria-hidden="true" />
          )}
          <p>
            <strong>{call.status === 'missed' ? 'Nadie contestó' : 'No se pudo conectar'}</strong>
            <span>
              {call.status === 'missed'
                ? 'Devuelve la llamada pronto para no perder al cliente.'
                : 'El número no respondió o rechazó la llamada.'}
            </span>
          </p>
          {canCallBack ? (
            <Button
              size="sm"
              variant="danger"
              icon={<PhoneOutgoing size={14} />}
              onClick={() => onCallback?.(call)}
            >
              {call.status === 'missed' ? 'Devolver llamada' : 'Reintentar'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {isActive ? (
        <CallConsole
          call={call}
          canUse={canUse}
          canSupervise={canSupervise}
          canControl={canControl}
          isParticipant={isParticipant}
          supervisionMode={supervisionMode}
          stream={stream}
          busy={busy}
          onJoin={join}
          onToggleAi={() =>
            post(call.aiState === 'active' ? '/ai/pause' : '/ai/resume', undefined, 'ai')
          }
          onToggleRecording={() =>
            post('/recording', { on: call.recordingState !== 'recording' }, 'rec')
          }
          onSupervise={supervise}
          onEndSupervision={() => post('/supervise/end', undefined, 'sup-end')}
          onTransfer={openTransfer}
          onEnd={() => setEndOpen(true)}
        />
      ) : null}

      {isActive && token ? (
        <div className="calls-d-room">
          <CallRoom token={token} />
        </div>
      ) : null}

      <div
        className="calls-tabs"
        role="tablist"
        aria-label="Información de la llamada"
        onKeyDown={onTabKeyDown}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`call-tab-${t.key}`}
            className="calls-tab"
            aria-selected={activeTab === t.key}
            aria-controls={`call-panel-${t.key}`}
            tabIndex={activeTab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count !== undefined ? <span className="calls-tab-count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div
        className="calls-tabpanel"
        role="tabpanel"
        id={`call-panel-${activeTab}`}
        aria-labelledby={`call-tab-${activeTab}`}
      >
        {activeTab === 'summary' ? (
          summary ? (
            <>
              <section className="calls-block">
                <div className="calls-block-head">
                  <h3 className="calls-eyebrow">Resumen</h3>
                  <span className="badge badge-info">
                    <Sparkles size={11} aria-hidden="true" /> Generado por IA
                  </span>
                  <button
                    type="button"
                    className="calls-link"
                    onClick={() => copy(call.summary ?? '', 'summary')}
                  >
                    {copied === 'summary' ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
                <p className="calls-summary">{summary.text}</p>
              </section>
              {summary.commitments.length > 0 ? (
                <section className="calls-block">
                  <h3 className="calls-eyebrow">Compromisos</h3>
                  <ul className="calls-checklist">
                    {summary.commitments.map((item, i) => (
                      <li key={i}>
                        <CircleCheck size={15} aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {summary.followUps.length > 0 ? (
                <section className="calls-block">
                  <h3 className="calls-eyebrow">Seguimientos</h3>
                  <ul className="calls-checklist is-followups">
                    {summary.followUps.map((item, i) => (
                      <li key={i}>
                        <CornerDownRight size={15} aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <p className="calls-fine">
                Revísalo antes de actuar: la IA no crea registros ni envía documentos por su cuenta.
              </p>
            </>
          ) : (
            <div className="calls-empty is-compact">
              <span className="calls-empty-icon" aria-hidden="true">
                <Sparkles size={18} />
              </span>
              <p>
                {segments.length === 0
                  ? 'Sin transcripción no se puede generar el resumen de esta llamada.'
                  : 'El resumen se genera al terminar la llamada y aparecerá aquí en cuanto esté listo.'}
              </p>
            </div>
          )
        ) : null}

        {activeTab === 'transcript' ? (
          <>
            {isActive && call.aiMode === 'copilot' && call.aiState !== 'off' ? (
              <section className="calls-block">
                <h3 className="calls-eyebrow">
                  <Lightbulb size={12} aria-hidden="true" /> Sugerencias del copiloto
                </h3>
                {call.aiState !== 'active' ? (
                  <p className="calls-fine">
                    El copiloto está en pausa. Reanuda la IA para recibir sugerencias.
                  </p>
                ) : suggestions.length === 0 ? (
                  <p className="calls-fine">
                    Las sugerencias aparecerán conforme avance la conversación.
                  </p>
                ) : (
                  <ul className="calls-sugs">
                    {suggestions.map((s, i) => (
                      <li key={i} className="calls-sug">
                        <span
                          className={`badge ${SUGGESTION_META[s.kind]?.badge ?? 'badge-default'}`}
                        >
                          {SUGGESTION_META[s.kind]?.label ?? 'Sugerencia'}
                        </span>
                        <p>{s.text}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {isActive && call.aiState !== 'active' && call.aiState !== 'off' ? (
              <p className="calls-note">
                La transcripción está detenida mientras la IA no está activa.
              </p>
            ) : null}

            {segments.length === 0 ? (
              <div className="calls-empty is-compact">
                <span className="calls-empty-icon" aria-hidden="true">
                  <MessageSquareText size={18} />
                </span>
                <p>
                  {isActive
                    ? 'La transcripción aparecerá aquí conforme hablen.'
                    : call.aiState === 'off'
                      ? 'La IA estaba apagada en esta llamada, por eso no hay transcripción.'
                      : 'Esta llamada no tiene transcripción guardada.'}
                </p>
              </div>
            ) : (
              <ol className="calls-transcript" aria-live={isActive ? 'polite' : undefined}>
                {segments.map((s, i) => {
                  const prev = segments[i - 1];
                  const seekable =
                    Boolean(call.recordingObjectId) && s.speakerIdentity === 'recording';
                  return (
                    <React.Fragment key={s.id}>
                      {prev && prev.generation !== s.generation ? (
                        <li className="calls-tr-gap" role="presentation">
                          IA reanudada · generación {s.generation}
                        </li>
                      ) : null}
                      <li className={`calls-tr is-${speakerKind(s.speakerIdentity)}`}>
                        <button
                          type="button"
                          className="calls-tr-time"
                          disabled={!seekable}
                          onClick={() => seekTo(s.startMs)}
                          title={
                            seekable
                              ? 'Escuchar desde aquí'
                              : new Date(s.createdAt).toLocaleString('es-MX')
                          }
                        >
                          {formatDuration(Math.floor(s.startMs / 1000))}
                        </button>
                        <div>
                          <span className="calls-tr-who">
                            {speakerLabel(s.speakerIdentity, call)}
                          </span>
                          <p>{s.text}</p>
                        </div>
                      </li>
                    </React.Fragment>
                  );
                })}
              </ol>
            )}

            {aiReplies.length > 0 ? (
              <section className="calls-block">
                <h3 className="calls-eyebrow">
                  <Bot size={12} aria-hidden="true" /> Respuestas de la asistente
                </h3>
                {aiReplies.map((r, i) => (
                  <div key={i} className="calls-ai-reply">
                    {r.text}
                    {r.pending.length > 0 ? (
                      <small>Pendiente de autorización humana: {r.pending.join('; ')}</small>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}

            {canControl && isActive && call.aiMode === 'answer' && call.aiState === 'active' ? (
              <div className="calls-turn">
                <input
                  className="input"
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendManualTurn();
                  }}
                  placeholder="Texto del cliente (prueba del ciclo de voz)"
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
          </>
        ) : null}

        {activeTab === 'recording' && call.recordingObjectId ? (
          <>
            <section className="calls-player" aria-label="Grabación">
              <audio
                ref={audioRef}
                controls
                preload="metadata"
                src={`/app/files/api/objects/${call.recordingObjectId}/content`}
                aria-label="Reproducir grabación de la llamada"
                onLoadedMetadata={(e) => {
                  e.currentTarget.playbackRate = rate;
                }}
              />
              <div className="calls-player-meta">
                <span>Velocidad</span>
                <div
                  className="calls-seg calls-seg-sm"
                  role="group"
                  aria-label="Velocidad de reproducción"
                >
                  {PLAYBACK_RATES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={rate === r}
                      onClick={() => {
                        setRate(r);
                        if (audioRef.current) audioRef.current.playbackRate = r;
                      }}
                    >
                      {r}×
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <dl className="calls-facts">
              <dt>Acceso</dt>
              <dd>Restringido a participantes y supervisores del equipo</dd>
              {call.recordingExpiresAt ? (
                <>
                  <dt>Se elimina</dt>
                  <dd>
                    {new Date(call.recordingExpiresAt).toLocaleDateString('es-MX', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </dd>
                </>
              ) : null}
            </dl>
          </>
        ) : null}

        {activeTab === 'people' ? (
          <ul className="calls-people">
            {call.participants.map((p) => {
              const ai = p.role === 'ai' || isAiIdentity(p.identity);
              const name = participantName(p, call);
              return (
                <li key={p.id} className={cn('calls-person', p.leftAt && 'has-left')}>
                  {ai ? (
                    <span className="calls-person-ai" aria-hidden="true">
                      <Bot size={16} />
                    </span>
                  ) : (
                    <Avatar name={name} size="sm" />
                  )}
                  <span className="calls-person-text">
                    <strong>
                      {name}
                      {p.userId === user.id ? ' (tú)' : ''}
                    </strong>
                    <span>
                      {ROLE_LABEL[p.role] ?? p.role} ·{' '}
                      {p.leftAt ? `salió ${timeLabel(p.leftAt)}` : `desde ${timeLabel(p.joinedAt)}`}
                      {p.muted ? ' · silenciado' : ''}
                    </span>
                  </span>
                  {!p.leftAt ? <span className="badge badge-success">En línea</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {activeTab === 'activity' ? (
          <ol className="calls-timeline">
            {buildActivity(call, user.id).map((event, i) => (
              <li key={i}>
                <time dateTime={event.at}>{timeLabel(event.at, true)}</time>
                <span className={`calls-tdot is-${event.tone}`} aria-hidden="true" />
                <span>{event.text}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <Modal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Transferir a una persona"
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
          help={
            call.aiMode === 'answer'
              ? 'La asistente se despide y deja de hablar; puede seguir como copiloto.'
              : 'La persona recibe un aviso y entra a la llamada.'
          }
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

      <Modal
        open={endOpen}
        onClose={() => setEndOpen(false)}
        title={`¿Terminar la llamada con ${title}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEndOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              icon={<PhoneOff size={14} />}
              isLoading={busy === 'end'}
              onClick={async () => {
                const data = await post('/end', undefined, 'end');
                if (data) setEndOpen(false);
              }}
            >
              Terminar llamada
            </Button>
          </>
        }
      >
        <p className="calls-modal-text">
          Se cuelga para todos los participantes
          {call.recordingState === 'recording' ? ', se detiene la grabación' : ''} y se genera el
          resumen.
        </p>
      </Modal>
    </div>
  );
}

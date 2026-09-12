'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Languages,
  MessageSquareReply,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  apiJson,
  formatDateTime,
  type CommConversationDTO,
  type CommitmentDTO,
  type CommitmentSuggestion,
  type InboxUserInfo,
  type InboxUserOption,
} from './inbox-types';

interface Props {
  conversation: CommConversationDTO;
  user: InboxUserInfo;
  users: InboxUserOption[];
  onInsertDraft: (text: string) => void;
  onConversationChanged: (conversation: CommConversationDTO) => void;
  onBack?: () => void;
}

type Action = 'summarize' | 'suggest_reply' | 'translate';

/**
 * Fixed AI panel. Every result is TEXT for the operator: the suggestion can be
 * inserted in the composer but is never sent by itself; suggested
 * commitments are created only when the operator clicks.
 */
export function AiPanel({
  conversation,
  user,
  users,
  onInsertDraft,
  onConversationChanged,
  onBack,
}: Props) {
  const [running, setRunning] = useState<Action | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const [targetLanguage, setTargetLanguage] = useState('español');
  const [instructions, setInstructions] = useState('');
  const [suggestedCommitments, setSuggestedCommitments] = useState<CommitmentSuggestion[]>([]);
  const [commitments, setCommitments] = useState<CommitmentDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [handoverTo, setHandoverTo] = useState('');
  const [handoverSummary, setHandoverSummary] = useState('');
  const [handingOver, setHandingOver] = useState(false);

  const loadCommitments = useCallback(async () => {
    try {
      const data = await apiJson<{ commitments: CommitmentDTO[] }>(
        `/app/inbox/api/commitments?contactId=${encodeURIComponent(conversation.contact.id)}`
      );
      setCommitments(data.commitments);
    } catch {
      setCommitments([]);
    }
  }, [conversation.contact.id]);

  useEffect(() => {
    void loadCommitments();
  }, [loadCommitments]);

  const run = async (action: Action) => {
    setRunning(action);
    setError(null);
    try {
      const data = await apiJson<{ result: string; commitments?: CommitmentSuggestion[] }>(
        `/app/inbox/api/conversations/${conversation.id}/ai`,
        {
          method: 'POST',
          body: JSON.stringify({ action, targetLanguage, instructions: instructions || undefined }),
        }
      );
      if (action === 'summarize') setSummary(data.result);
      if (action === 'suggest_reply') {
        setSuggestion(data.result);
        setSuggestedCommitments(data.commitments ?? []);
      }
      if (action === 'translate') setTranslation(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La IA no está disponible');
    } finally {
      setRunning(null);
    }
  };

  const createCommitment = async (s: CommitmentSuggestion) => {
    try {
      await apiJson('/app/inbox/api/commitments', {
        method: 'POST',
        body: JSON.stringify({
          description: s.description,
          dueAt: s.dueAt,
          contactId: conversation.contact.id,
          sourceType: 'comm_message',
          sourceId: conversation.id,
        }),
      });
      setSuggestedCommitments((prev) => prev.filter((x) => x !== s));
      toast.success('Compromiso registrado');
      void loadCommitments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar');
    }
  };

  const completeCommitment = async (id: string) => {
    try {
      await apiJson(`/app/inbox/api/commitments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      });
      void loadCommitments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
    }
  };

  const handover = async () => {
    if (!handoverTo) return;
    setHandingOver(true);
    try {
      const data = await apiJson<{ conversation: CommConversationDTO; generatedByAi: boolean }>(
        `/app/inbox/api/conversations/${conversation.id}/handover`,
        {
          method: 'POST',
          body: JSON.stringify({ toUserId: handoverTo, summary: handoverSummary || undefined }),
        }
      );
      onConversationChanged(data.conversation);
      toast.success(
        data.generatedByAi
          ? 'Relevo realizado con resumen de IA'
          : 'Relevo realizado (resumen de los últimos mensajes)'
      );
      setHandoverSummary('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo relevar');
    } finally {
      setHandingOver(false);
    }
  };

  const canHandover = user.canAssign || conversation.assignedToUserId === user.id;
  const section: React.CSSProperties = {
    padding: '10px 14px',
    borderBottom: '1px solid var(--unik-border-subtle)',
  };
  const resultBox: React.CSSProperties = {
    whiteSpace: 'pre-wrap',
    fontSize: 'var(--unik-text-sm)',
    background: 'var(--unik-bg)',
    border: '1px solid var(--unik-border-subtle)',
    borderRadius: 8,
    padding: 8,
    marginTop: 6,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ ...section, display: 'flex', alignItems: 'center', gap: 8 }}>
        {onBack && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onBack}
            aria-label="Volver a la conversación"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <Sparkles size={16} aria-hidden="true" />
        <strong>Asistente</strong>
        <span
          className="assistant-admin-muted"
          style={{ marginLeft: 'auto', fontSize: 'var(--unik-text-xs)' }}
        >
          Nunca envía por sí solo
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {error && (
          <div className="assistant-admin-error" role="alert" style={{ margin: 12 }}>
            {error}
          </div>
        )}

        <section style={section} aria-label="Resumen">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={running !== null}
            onClick={() => void run('summarize')}
          >
            {running === 'summarize' ? 'Resumiendo…' : 'Resumir conversación'}
          </button>
          {summary && <div style={resultBox}>{summary}</div>}
        </section>

        <section style={section} aria-label="Sugerencia de respuesta">
          <input
            className="input"
            aria-label="Indicaciones para la respuesta"
            placeholder="Indicaciones (opcional): tono, datos a incluir…"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            style={{ width: '100%', marginBottom: 6 }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={running !== null}
            onClick={() => void run('suggest_reply')}
          >
            <MessageSquareReply size={14} />{' '}
            {running === 'suggest_reply' ? 'Redactando…' : 'Sugerir respuesta'}
          </button>
          {suggestion && (
            <>
              <div style={resultBox}>{suggestion}</div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ marginTop: 6 }}
                onClick={() => onInsertDraft(suggestion)}
              >
                Insertar en el redactor
              </button>
            </>
          )}
          {suggestedCommitments.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="assistant-admin-list-meta">
                Compromisos detectados en la sugerencia
              </div>
              {suggestedCommitments.map((s, i) => (
                <div
                  key={`${i}-${s.description}`}
                  style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4 }}
                >
                  <div style={{ flex: 1, fontSize: 'var(--unik-text-sm)' }}>
                    {s.description}
                    {s.dueAt && (
                      <div className="assistant-admin-muted">Vence {formatDateTime(s.dueAt)}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void createCommitment(s)}
                    aria-label="Registrar compromiso"
                  >
                    <CalendarClock size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={section} aria-label="Traducción">
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              className="select"
              aria-label="Idioma destino"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="español">Español</option>
              <option value="inglés">Inglés</option>
              <option value="portugués">Portugués</option>
              <option value="francés">Francés</option>
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={running !== null}
              onClick={() => void run('translate')}
              aria-label="Traducir último mensaje del contacto"
            >
              <Languages size={14} /> {running === 'translate' ? '…' : 'Traducir'}
            </button>
          </div>
          {translation && <div style={resultBox}>{translation}</div>}
        </section>

        <section style={section} aria-label="Compromisos con el contacto">
          <div className="assistant-admin-list-meta" style={{ marginBottom: 4 }}>
            Compromisos con {conversation.contact.displayName}
          </div>
          {commitments.length === 0 && (
            <p className="assistant-admin-muted" style={{ fontSize: 'var(--unik-text-sm)' }}>
              Sin compromisos pendientes.
            </p>
          )}
          {commitments.map((c) => (
            <div
              key={c.id}
              style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 6 }}
            >
              <div style={{ flex: 1, fontSize: 'var(--unik-text-sm)' }}>
                {c.description}
                <div className="assistant-admin-muted">
                  {c.ownerName ?? '—'}
                  {c.dueAt ? ` · vence ${formatDateTime(c.dueAt)}` : ''}
                  {c.status === 'overdue' && (
                    <span className="badge badge-danger" style={{ marginLeft: 6 }}>
                      Vencido
                    </span>
                  )}
                </div>
              </div>
              {c.ownerUserId === user.id && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void completeCommitment(c.id)}
                  aria-label="Marcar como cumplido"
                >
                  <Check size={14} />
                </button>
              )}
            </div>
          ))}
        </section>

        <section style={section} aria-label="Relevo asistido">
          <div className="assistant-admin-list-meta" style={{ marginBottom: 4 }}>
            <UserRoundCheck size={14} aria-hidden="true" /> Relevo asistido de operador
          </div>
          <select
            className="select"
            aria-label="Relevar a"
            value={handoverTo}
            onChange={(e) => setHandoverTo(e.target.value)}
            disabled={!canHandover}
            style={{ width: '100%', marginBottom: 6 }}
          >
            <option value="">Elegir operador…</option>
            {users
              .filter((u) => u.id !== user.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
          <textarea
            className="input"
            aria-label="Resumen del relevo (opcional)"
            placeholder="Resumen opcional; si lo dejas vacío la IA lo genera a partir de los últimos mensajes"
            value={handoverSummary}
            onChange={(e) => setHandoverSummary(e.target.value)}
            rows={2}
            disabled={!canHandover}
            style={{ width: '100%', marginBottom: 6 }}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!canHandover || !handoverTo || handingOver}
            onClick={() => void handover()}
          >
            {handingOver ? 'Relevando…' : 'Relevar conversación'}
          </button>
          {!canHandover && (
            <p
              className="assistant-admin-muted"
              style={{ fontSize: 'var(--unik-text-xs)', marginTop: 4 }}
            >
              Solo el asignado o quien puede asignar puede relevar.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

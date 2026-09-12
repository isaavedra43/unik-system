'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Image as ImageIcon,
  MessageSquareText,
  Sparkles,
  StickyNote,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { MessageComposer } from './MessageComposer';
import {
  apiJson,
  formatDateTime,
  initials,
  MESSAGE_STATUS_LABELS,
  PROVIDER_LABELS,
  STATUS_LABELS,
  type CommConversationDTO,
  type CommMessageDTO,
  type CommNoteDTO,
  type InboxUserInfo,
  type InboxUserOption,
} from './inbox-types';

interface Props {
  conversation: CommConversationDTO;
  user: InboxUserInfo;
  users: InboxUserOption[];
  draft: string;
  onDraftChange: (value: string) => void;
  threadVersion: number;
  onConversationChanged: (conversation: CommConversationDTO) => void;
  onBack?: () => void;
  onToggleAi: () => void;
  aiOpen: boolean;
}

function StatusIcon({ message }: { message: CommMessageDTO }) {
  if (message.direction !== 'outbound') return null;
  const label = MESSAGE_STATUS_LABELS[message.status] ?? message.status;
  const title = message.uncertain
    ? `${label} (sin confirmación del proveedor)`
    : message.error
      ? `${label}: ${message.error}`
      : label;
  const icon =
    message.status === 'read' ? (
      <CheckCheck size={14} />
    ) : message.status === 'delivered' ? (
      <CheckCheck size={14} style={{ opacity: 0.6 }} />
    ) : message.status === 'sent' ? (
      <Check size={14} />
    ) : message.status === 'failed' || message.status === 'undelivered' ? (
      <TriangleAlert size={14} />
    ) : (
      <Clock size={14} />
    );
  return (
    <span
      className="chat-msg-read"
      title={title}
      aria-label={title}
      style={
        message.status === 'failed' || message.status === 'undelivered'
          ? { color: 'var(--unik-danger)' }
          : undefined
      }
    >
      {icon}
    </span>
  );
}

function MediaList({ message }: { message: CommMessageDTO }) {
  if (message.media.length === 0 && message.pendingMedia === 0) return null;
  return (
    <div
      className="chat-msg-attachments"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}
    >
      {message.media.map((m) =>
        m.mimeType.startsWith('image/') ? (
          <a
            key={m.id}
            href={m.url}
            target="_blank"
            rel="noreferrer"
            className="chat-att-image"
            aria-label={`Abrir imagen ${m.name}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={m.url}
              alt={m.name}
              className="chat-att-img"
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, display: 'block' }}
            />
          </a>
        ) : m.mimeType.startsWith('audio/') ? (
          <audio
            key={m.id}
            controls
            src={m.url}
            preload="none"
            style={{ maxWidth: 260 }}
            aria-label={m.name}
          />
        ) : (
          <a
            key={m.id}
            href={`${m.url}?download=1`}
            className="chat-att-doc"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {m.mimeType === 'application/pdf' ? <FileText size={16} /> : <ImageIcon size={16} />}
            <span className="chat-att-doc-name">{m.name}</span>
          </a>
        )
      )}
      {message.pendingMedia > 0 && (
        <span className="badge badge-info" title="El adjunto se está descargando del proveedor">
          {message.pendingMedia} adjunto(s) en proceso…
        </span>
      )}
    </div>
  );
}

export function ConversationView({
  conversation,
  user,
  users,
  draft,
  onDraftChange,
  threadVersion,
  onConversationChanged,
  onBack,
  onToggleAi,
  aiOpen,
}: Props) {
  const [messages, setMessages] = useState<CommMessageDTO[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<CommNoteDTO[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async () => {
    try {
      const data = await apiJson<{ items: CommMessageDTO[]; hasMore: boolean }>(
        `/app/inbox/api/conversations/${conversation.id}/messages?limit=60`
      );
      setMessages(data.items);
      setHasMore(data.hasMore);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los mensajes');
    } finally {
      setLoading(false);
    }
  }, [conversation.id]);

  const loadNotes = useCallback(async () => {
    try {
      const data = await apiJson<{ notes: CommNoteDTO[] }>(
        `/app/inbox/api/conversations/${conversation.id}/notes`
      );
      setNotes(data.notes);
    } catch {
      // notes are secondary; keep the thread usable
    }
  }, [conversation.id]);

  useEffect(() => {
    setLoading(true);
    void loadMessages();
    void loadNotes();
    fetch(`/app/inbox/api/conversations/${conversation.id}/read`, { method: 'POST' }).catch(
      () => undefined
    );
  }, [conversation.id, loadMessages, loadNotes, threadVersion]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const loadOlder = async () => {
    const first = messages[0];
    if (!first) return;
    try {
      const data = await apiJson<{ items: CommMessageDTO[]; hasMore: boolean }>(
        `/app/inbox/api/conversations/${conversation.id}/messages?limit=60&before=${encodeURIComponent(first.id)}`
      );
      setMessages((prev) => [...data.items, ...prev]);
      setHasMore(data.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cargar el historial');
    }
  };

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const data = await apiJson<{ conversation: CommConversationDTO }>(
        `/app/inbox/api/conversations/${conversation.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        }
      );
      onConversationChanged(data.conversation);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar');
    } finally {
      setBusy(false);
    }
  };

  const send = async (body: string, mediaObjectIds: string[]) => {
    setSendError(null);
    try {
      const data = await apiJson<{ message: CommMessageDTO }>(
        `/app/inbox/api/conversations/${conversation.id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ body, mediaObjectIds }),
        }
      );
      setMessages((prev) => [...prev, data.message]);
      onDraftChange('');
      if (data.message.status === 'failed')
        toast.error(data.message.error ?? 'El proveedor rechazó el mensaje');
      else if (data.message.uncertain)
        toast.warning('El proveedor no confirmó el envío; se actualizará por webhook');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo enviar';
      setSendError(message);
      toast.error(message);
    }
  };

  const addNote = async () => {
    if (!noteDraft.trim()) return;
    setSavingNote(true);
    try {
      const data = await apiJson<{ note: CommNoteDTO }>(
        `/app/inbox/api/conversations/${conversation.id}/notes`,
        {
          method: 'POST',
          body: JSON.stringify({ body: noteDraft }),
        }
      );
      setNotes((prev) => [...prev, data.note]);
      setNoteDraft('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la nota');
    } finally {
      setSavingNote(false);
    }
  };

  const canChangeStatus = user.canAssign || conversation.assignedToUserId === user.id;
  const canAssignOthers = user.canAssign;
  const contact = conversation.contact;
  const identifier =
    contact.phone ??
    (contact.telegramId ? `Telegram ${contact.telegramId}` : (contact.email ?? ''));

  return (
    <div className="chat-conversation">
      <header className="chat-conversation-header" style={{ flexWrap: 'wrap', rowGap: 6 }}>
        {onBack && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onBack}
            aria-label="Volver a la lista"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="chat-avatar" aria-hidden="true">
          {initials(contact.displayName)}
        </span>
        <div className="chat-conversation-info" style={{ minWidth: 0 }}>
          <div
            className="chat-conversation-name"
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
          >
            {contact.displayName}
            <span className="badge badge-weak">
              {PROVIDER_LABELS[conversation.account.provider] ?? conversation.account.provider}
            </span>
            {contact.duplicateReviewStatus === 'pending' && (
              <span className="badge badge-warning" title="Posible duplicado pendiente de revisión">
                Posible duplicado
              </span>
            )}
          </div>
          <div className="chat-conversation-subtitle">
            {identifier} · {conversation.account.label}
            {contact.zohoContactId ? ' · vinculado a Zoho' : ''}
          </div>
        </div>
        <div
          className="chat-conversation-actions"
          style={{
            display: 'flex',
            gap: 6,
            marginLeft: 'auto',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <select
            className="select"
            aria-label="Asignar a"
            value={conversation.assignedToUserId ?? ''}
            disabled={busy || (!canAssignOthers && Boolean(conversation.assignedToUserId))}
            onChange={(e) => patch({ assignedToUserId: e.target.value || null })}
          >
            <option value="">Sin asignar</option>
            {(canAssignOthers
              ? users
              : users.filter((u) => u.id === user.id || u.id === conversation.assignedToUserId)
            ).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Estado"
            value={conversation.status}
            disabled={busy || !canChangeStatus}
            onChange={(e) => patch({ status: e.target.value })}
          >
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Prioridad"
            value={conversation.priority}
            disabled={busy}
            onChange={(e) => patch({ priority: e.target.value })}
          >
            <option value="normal">Normal</option>
            <option value="high">Alta</option>
            <option value="urgent">Urgente</option>
          </select>
          <button
            type="button"
            className={cn('btn btn-sm', showNotes ? 'btn-secondary' : 'btn-ghost')}
            onClick={() => setShowNotes((v) => !v)}
            aria-pressed={showNotes}
            aria-label="Notas internas"
          >
            <StickyNote size={16} /> {notes.length > 0 ? notes.length : ''}
          </button>
          <button
            type="button"
            className={cn('btn btn-sm', aiOpen ? 'btn-secondary' : 'btn-ghost')}
            onClick={onToggleAi}
            aria-pressed={aiOpen}
            aria-label="Panel de IA"
          >
            <Sparkles size={16} />
          </button>
        </div>
      </header>

      {conversation.tags.length > 0 && (
        <div style={{ padding: '4px 16px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {conversation.tags.map((tag) => (
            <span key={tag} className="badge badge-info">
              {tag}
            </span>
          ))}
        </div>
      )}

      {showNotes && (
        <section
          aria-label="Notas internas"
          style={{
            borderBottom: '1px solid var(--unik-border)',
            padding: '8px 16px',
            maxHeight: 220,
            overflowY: 'auto',
            background: 'var(--unik-warning-bg)',
          }}
        >
          {notes.length === 0 && (
            <p className="assistant-admin-muted">Sin notas internas. Solo tu equipo las ve.</p>
          )}
          {notes.map((n) => (
            <div key={n.id} style={{ marginBottom: 8 }}>
              <div className="assistant-admin-list-meta">
                {n.authorName ?? 'Usuario'} · {formatDateTime(n.createdAt)}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--unik-text-sm)' }}>
                {n.body}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input"
              aria-label="Nueva nota interna"
              placeholder="Nota interna…"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addNote()}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={savingNote || !noteDraft.trim()}
              onClick={() => void addNote()}
            >
              Guardar
            </button>
          </div>
        </section>
      )}

      <div ref={scroller} className="chat-messages" role="log" aria-live="polite">
        {loading && <div className="chat-messages-loading">Cargando mensajes…</div>}
        {error && (
          <div className="chat-messages-error" role="alert">
            {error}{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void loadMessages()}
            >
              Reintentar
            </button>
          </div>
        )}
        {hasMore && !loading && (
          <button
            type="button"
            className="chat-load-more btn btn-ghost btn-sm"
            onClick={() => void loadOlder()}
            style={{ alignSelf: 'center' }}
          >
            Cargar mensajes anteriores
          </button>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="chat-messages-empty" style={{ margin: 'auto', textAlign: 'center' }}>
            <MessageSquareText size={28} aria-hidden="true" />
            <p className="chat-messages-empty-text">Aún no hay mensajes en esta conversación.</p>
          </div>
        )}
        {messages.map((m) => {
          const own = m.direction === 'outbound';
          return (
            <div key={m.id} className={cn('chat-msg-wrapper', own && 'own')}>
              <div className={cn('chat-msg-bubble', own ? 'own' : 'other')}>
                {m.body && (
                  <div className="chat-msg-text" style={{ whiteSpace: 'pre-wrap' }}>
                    {m.body}
                  </div>
                )}
                <MediaList message={m} />
                <div
                  className="chat-msg-meta"
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                  }}
                >
                  {own && m.sentByName && <span>{m.sentByName}</span>}
                  <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>
                  <StatusIcon message={m} />
                </div>
                {(m.status === 'failed' || m.status === 'undelivered') && m.error && (
                  <div style={{ color: 'var(--unik-danger)', fontSize: 'var(--unik-text-xs)' }}>
                    {m.error}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <MessageComposer
        conversationId={conversation.id}
        value={draft}
        onChange={onDraftChange}
        onSend={send}
        disabledReason={sendError}
      />
    </div>
  );
}

'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  Reply,
  Forward,
  Pencil,
  Trash2,
  Smile,
  MoreHorizontal,
  Check,
  CheckCheck,
  CornerUpRight,
} from 'lucide-react';
import type { ChatMessageDTO } from '@/modules/chat/chat-events';
import { ChatAttachmentPreview } from './ChatAttachmentPreview';

export interface ChatMessageProps {
  message: ChatMessageDTO;
  isOwn: boolean;
  showAvatar: boolean;
  senderName: string;
  onReply: () => void;
  onReaction: (messageId: string, emoji: string) => void;
  onRemoveReaction: (messageId: string, emoji: string) => void;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onForward: (messageId: string, targetChannelIds: string[]) => void;
  channelId: string;
  currentUserId: string;
}

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
const ALL_EMOJIS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🎉',
  '🔥',
  '👏',
  '🙏',
  '💯',
  '✅',
  '❌',
  '👀',
  '💪',
  '🤝',
  '😅',
  '🤔',
  '⭐',
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

export function ChatMessage({
  message,
  isOwn,
  showAvatar,
  senderName,
  onReply,
  onReaction,
  onRemoveReaction,
  onEdit,
  onDelete,
  onForward,
  channelId,
  currentUserId,
}: ChatMessageProps) {
  const [showActions, setShowActions] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content ?? '');
  const [showForwardDialog, setShowForwardDialog] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.setSelectionRange(editContent.length, editContent.length);
    }
  }, [editing, editContent.length]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node))
        setShowActions(false);
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node))
        setShowEmojiPicker(false);
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setShowMoreActions(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleSaveEdit = () => {
    const trimmed = editContent.trim();
    if (trimmed && trimmed !== message.content) {
      onEdit(message.id, trimmed);
    }
    setEditing(false);
  };

  const handleEmojiClick = (emoji: string) => {
    const hasReacted = message.reactions.some(
      (r) => r.userId === currentUserId && r.emoji === emoji
    );
    if (hasReacted) {
      onRemoveReaction(message.id, emoji);
    } else {
      onReaction(message.id, emoji);
    }
    setShowEmojiPicker(false);
  };

  // Group reactions by emoji
  const reactionGroups = message.reactions.reduce<
    Record<string, { count: number; userIds: string[]; names: string[] }>
  >((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = { count: 0, userIds: [], names: [] };
    acc[r.emoji].count++;
    acc[r.emoji].userIds.push(r.userId);
    acc[r.emoji].names.push(r.userName);
    return acc;
  }, {});

  const isDeleted = !!message.deletedAt;
  const isForwarded = !!message.forwardedFromId;
  const canEdit = isOwn && !isDeleted && !message.attachments.length;
  const canDelete = isOwn;

  return (
    <div
      className={`chat-msg-wrapper ${isOwn ? 'own' : ''} ${showAvatar ? 'with-avatar' : 'compact'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Avatar */}
      {showAvatar && !isOwn && (
        <div className="chat-msg-avatar">{senderName.slice(0, 2).toUpperCase()}</div>
      )}
      {showAvatar && isOwn && <div className="chat-msg-avatar-spacer" />}

      <div className="chat-msg-content">
        {/* Sender name (groups only, not own) */}
        {showAvatar && !isOwn && <div className="chat-msg-sender">{senderName}</div>}

        {/* Reply quote */}
        {message.replyToId && message.replyToPreview && (
          <div className="chat-msg-reply">
            <CornerUpRight size={14} />
            <div className="chat-msg-reply-content">
              <span className="chat-msg-reply-sender">{message.replyToSenderName}</span>
              <span className="chat-msg-reply-text">{message.replyToPreview.slice(0, 100)}</span>
            </div>
          </div>
        )}

        {/* Forwarded badge */}
        {isForwarded && !isDeleted && (
          <div className="chat-msg-forwarded">
            <Forward size={12} /> Reenviado
          </div>
        )}

        {/* Message bubble */}
        {isDeleted ? (
          <div className={`chat-msg-bubble ${isOwn ? 'own' : 'other'} deleted`}>
            Este mensaje fue eliminado
          </div>
        ) : editing ? (
          <div className="chat-msg-edit">
            <textarea
              ref={editInputRef}
              className="chat-msg-edit-input"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveEdit();
                }
                if (e.key === 'Escape') setEditing(false);
              }}
              rows={2}
            />
            <div className="chat-msg-edit-actions">
              <button type="button" onClick={() => setEditing(false)}>
                Cancelar
              </button>
              <button type="button" onClick={handleSaveEdit}>
                Guardar
              </button>
            </div>
          </div>
        ) : (
          <div className={`chat-msg-bubble ${isOwn ? 'own' : 'other'}`}>
            {message.content && <div className="chat-msg-text">{message.content}</div>}
            {message.attachments.length > 0 && (
              <div className="chat-msg-attachments">
                {message.attachments.map((att) => (
                  <ChatAttachmentPreview key={att.id} attachment={att} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Reactions */}
        {!isDeleted && Object.keys(reactionGroups).length > 0 && (
          <div className="chat-msg-reactions">
            {Object.entries(reactionGroups).map(([emoji, info]) => {
              const hasReacted = info.userIds.includes(currentUserId);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`chat-msg-reaction ${hasReacted ? 'active' : ''}`}
                  onClick={() => onRemoveReaction(message.id, emoji)}
                  title={info.names.join(', ')}
                >
                  <span className="chat-msg-reaction-emoji">{emoji}</span>
                  <span className="chat-msg-reaction-count">{info.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Meta: time + read status */}
        <div className="chat-msg-meta">
          <span className="chat-msg-time">{formatTime(message.createdAt)}</span>
          {message.editedAt && <span className="chat-msg-edited">editado</span>}
          {isOwn && !isDeleted && (
            <span className="chat-msg-read">
              {message.readBy.length > 0 ? <CheckCheck size={14} /> : <Check size={14} />}
            </span>
          )}
        </div>
      </div>

      {/* Action toolbar */}
      {showActions && !isDeleted && !editing && (
        <div className="chat-msg-actions" ref={actionsRef}>
          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            aria-label="Reaccionar"
          >
            <Smile size={16} />
          </button>
          <button type="button" onClick={onReply} aria-label="Responder">
            <Reply size={16} />
          </button>
          <button type="button" onClick={() => setShowForwardDialog(true)} aria-label="Reenviar">
            <Forward size={16} />
          </button>
          <div className="chat-msg-actions-more" ref={moreRef}>
            <button
              type="button"
              onClick={() => setShowMoreActions(!showMoreActions)}
              aria-label="Más"
            >
              <MoreHorizontal size={16} />
            </button>
            {showMoreActions && (
              <div className="chat-msg-more-menu">
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(true);
                      setShowMoreActions(false);
                    }}
                  >
                    <Pencil size={14} /> Editar
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => {
                      onDelete(message.id);
                      setShowMoreActions(false);
                    }}
                    className="danger"
                  >
                    <Trash2 size={14} /> Eliminar
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Emoji picker */}
      {showEmojiPicker && (
        <div className="chat-emoji-picker" ref={emojiRef}>
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="chat-emoji-btn"
              onClick={() => handleEmojiClick(emoji)}
            >
              {emoji}
            </button>
          ))}
          <div className="chat-emoji-divider" />
          {ALL_EMOJIS.slice(6).map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="chat-emoji-btn"
              onClick={() => handleEmojiClick(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* Forward dialog */}
      {showForwardDialog && (
        <ForwardDialog
          messageId={message.id}
          currentChannelId={channelId}
          onClose={() => setShowForwardDialog(false)}
          onForward={onForward}
        />
      )}
    </div>
  );
}

// Inline forward dialog
function ForwardDialog({
  messageId,
  currentChannelId,
  onClose,
  onForward,
}: {
  messageId: string;
  currentChannelId: string;
  onClose: () => void;
  onForward: (messageId: string, targetChannelIds: string[]) => void;
}) {
  const [channels, setChannels] = useState<{ id: string; name: string; type: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/app/chat/api/channels')
      .then((r) => r.json())
      .then((data) => {
        setChannels(
          data.data
            .filter((c: { id: string }) => c.id !== currentChannelId)
            .map(
              (c: {
                id: string;
                name: string | null;
                type: string;
                members: { name: string }[];
              }) => ({
                id: c.id,
                name:
                  c.type === 'group'
                    ? c.name
                    : (c.members.find((m: { name: string }) => m)?.name ?? 'Chat'),
                type: c.type,
              })
            )
        );
      })
      .catch(() => {});
  }, [currentChannelId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleForward = () => {
    setLoading(true);
    onForward(messageId, Array.from(selected));
    onClose();
  };

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>Reenviar a...</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <span style={{ fontSize: '20px' }}>×</span>
          </button>
        </div>
        <div className="chat-dialog-list">
          {channels.length === 0 ? (
            <div className="chat-dialog-empty">No hay otros canales</div>
          ) : (
            channels.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`chat-dialog-user ${selected.has(c.id) ? 'selected' : ''}`}
                onClick={() => toggle(c.id)}
              >
                <div className="chat-dialog-user-avatar">
                  {c.type === 'group' ? '👥' : c.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="chat-dialog-user-info">
                  <div className="chat-dialog-user-name">{c.name}</div>
                </div>
                {selected.has(c.id) && <Check size={18} className="chat-dialog-check" />}
              </button>
            ))
          )}
        </div>
        <div className="chat-dialog-footer">
          <button type="button" className="chat-dialog-cancel" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="chat-dialog-create"
            disabled={loading || selected.size === 0}
            onClick={handleForward}
          >
            {loading
              ? 'Reenviando...'
              : `Reenviar${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

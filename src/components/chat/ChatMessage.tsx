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
  Bookmark,
  Pin,
  Languages,
  AlertCircle,
  MessageSquareText,
} from 'lucide-react';
import type { ChatMessageDTO } from '@/modules/chat/chat-events';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/shadcn/dialog';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/shadcn/dropdown-menu';
import { ChatEmojiPicker } from './ChatEmojiPicker';
import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatAttachmentPreview } from './ChatAttachmentPreview';
import { ChatLocationMap } from './ChatLocationMap';
import { ChatPollMessage } from './ChatPollMessage';
import { ChatEventMessage } from './ChatEventMessage';
import { ChatReadReceiptsDialog } from './ChatReadReceiptsDialog';

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
  onBookmark: (messageId: string) => void;
  onUnbookmark: (messageId: string) => void;
  onPin: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
  onTranslate: (messageId: string) => void;
  onVotePoll: (pollId: string, optionIds: string[]) => void;
  onRsvpEvent: (eventId: string, status: 'yes' | 'no' | 'maybe') => void;
  onOpenThread?: (threadId: string, rootMessage: ChatMessageDTO) => void;
  channelId: string;
  currentUserId: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function renderContentWithMentions(content: string): React.ReactNode {
  // Split by @username patterns and render as chips
  const parts = content.split(/(@\w+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@') && part.length > 1) {
      return (
        <span key={i} className="chat-mention-chip">
          {part}
        </span>
      );
    }
    return part;
  });
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
  onBookmark,
  onUnbookmark,
  onPin,
  onUnpin,
  onTranslate,
  onVotePoll,
  onRsvpEvent,
  onOpenThread,
  channelId,
  currentUserId,
}: ChatMessageProps) {
  const [showActions, setShowActions] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content ?? '');
  const [showForwardDialog, setShowForwardDialog] = useState(false);
  const [showReaders, setShowReaders] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
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
          <div
            className={`chat-msg-bubble ${isOwn ? 'own' : 'other'} ${message.priority === 'urgent' ? 'urgent' : ''}`}
          >
            {message.priority === 'urgent' && (
              <div className="chat-msg-urgent-badge">
                <AlertCircle size={12} /> URGENTE
              </div>
            )}
            {message.content && (
              <div className="chat-msg-text">{renderContentWithMentions(message.content)}</div>
            )}
            {message.attachments.length > 0 && (
              <div className="chat-msg-attachments">
                {message.attachments.map((att) => (
                  <ChatAttachmentPreview key={att.id} attachment={att} />
                ))}
              </div>
            )}
            {message.location && (
              <ChatLocationMap
                latitude={message.location.latitude}
                longitude={message.location.longitude}
                label={message.location.label}
              />
            )}
            {message.poll && (
              <ChatPollMessage
                poll={message.poll}
                onVote={(optionIds) => onVotePoll(message.poll!.id, optionIds)}
              />
            )}
            {message.event && (
              <ChatEventMessage
                event={message.event}
                onRsvp={(status) => onRsvpEvent(message.event!.id, status)}
              />
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
          {message.threadId && onOpenThread && (
            <button
              type="button"
              className="chat-msg-thread-btn"
              onClick={() => onOpenThread(message.threadId!, message)}
              aria-label="Ver hilo"
              title="Ver hilo"
            >
              <MessageSquareText size={12} /> Hilo
            </button>
          )}
          {isOwn && !isDeleted && (
            <button
              type="button"
              className="chat-msg-read"
              onClick={() => setShowReaders(true)}
              aria-label="Ver lecturas"
              title="Visto por"
            >
              {message.readBy.length > 0 ? <CheckCheck size={14} /> : <Check size={14} />}
            </button>
          )}
        </div>
      </div>

      {/* Action toolbar */}
      {showActions && !isDeleted && !editing && (
        <div className="chat-msg-actions" ref={actionsRef}>
          <ChatEmojiPicker onSelect={(emoji) => onReaction(message.id, emoji)} align="end">
            <button type="button" aria-label="Reaccionar" className="chat-msg-action-btn">
              <Smile size={16} />
            </button>
          </ChatEmojiPicker>
          <button type="button" onClick={onReply} aria-label="Responder" className="chat-msg-action-btn">
            <Reply size={16} />
          </button>
          <button type="button" onClick={() => setShowForwardDialog(true)} aria-label="Reenviar" className="chat-msg-action-btn">
            <Forward size={16} />
          </button>
          <button type="button" onClick={() => onTranslate(message.id)} aria-label="Traducir" className="chat-msg-action-btn">
            <Languages size={16} />
          </button>
          <DropdownMenu open={showMoreActions} onOpenChange={setShowMoreActions}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Más" className="chat-msg-action-btn">
                <MoreHorizontal size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEdit && (
                <DropdownMenuItem onClick={() => { setEditing(true); setShowMoreActions(false); }}>
                  <Pencil size={14} /> Editar
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => {
                if (message.isBookmarked) onUnbookmark(message.id);
                else onBookmark(message.id);
                setShowMoreActions(false);
              }}>
                <Bookmark size={14} /> {message.isBookmarked ? 'Quitar de favoritos' : 'Guardar en favoritos'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                if (message.isPinned) onUnpin(message.id);
                else onPin(message.id);
                setShowMoreActions(false);
              }}>
                <Pin size={14} /> {message.isPinned ? 'Desfijar' : 'Fijar'}
              </DropdownMenuItem>
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => { onDelete(message.id); setShowMoreActions(false); }}
                    className="text-destructive"
                  >
                    <Trash2 size={14} /> Eliminar
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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

      {/* Read receipts dialog */}
      {showReaders && (
        <ChatReadReceiptsDialog messageId={message.id} onClose={() => setShowReaders(false)} />
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
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reenviar a...</DialogTitle>
          <DialogDescription>Selecciona una o más conversaciones</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[40vh]">
          <div className="flex flex-col gap-1 pr-3">
            {channels.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No hay otros canales
              </div>
            ) : (
              channels.map((c) => {
                const isSelected = selected.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={cn(
                      'flex items-center gap-3 rounded-md p-2 text-left transition-colors',
                      'hover:bg-accent focus:bg-accent focus:outline-none',
                      isSelected && 'bg-accent'
                    )}
                    onClick={() => toggle(c.id)}
                  >
                    <Avatar className="size-8">
                      <AvatarFallback className="text-xs font-semibold">
                        {c.type === 'group' ? <Users size={14} /> : c.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex-1 text-sm font-medium text-foreground truncate">
                      {c.name}
                    </span>
                    {isSelected && <Check size={18} className="text-primary shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={loading || selected.size === 0} onClick={handleForward}>
            {loading
              ? 'Reenviando...'
              : `Reenviar${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

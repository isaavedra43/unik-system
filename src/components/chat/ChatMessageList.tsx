'use client';

import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { ArrowDown, AlertCircle, RefreshCw, MessageCircle } from 'lucide-react';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { Button } from '@/components/ui/primitives';
import type { ChatMessageDTO } from '@/modules/chat/chat-events';
import { ChatMessage } from './ChatMessage';

export interface ChatMessageListProps {
  messages: ChatMessageDTO[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  currentUserId: string;
  onReply: (msg: ChatMessageDTO) => void;
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
  isGroup?: boolean;
  typingText?: string;
}

interface DateGroup {
  date: string;
  messages: ChatMessageDTO[];
}

function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - msgDate.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7) return date.toLocaleDateString('es-MX', { weekday: 'long' });
  return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function ChatMessageList({
  messages, loading, error, hasMore, loadingMore, onLoadMore,
  currentUserId, onReply, onReaction, onRemoveReaction, onEdit, onDelete,
  onForward, onBookmark, onUnbookmark, onPin, onUnpin, onTranslate,
  onVotePoll, onRsvpEvent, onOpenThread, channelId, isGroup = true, typingText,
}: ChatMessageListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);
  const wasAtBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const grouped = useMemo<DateGroup[]>(() => {
    const groups: DateGroup[] = [];
    for (const msg of messages) {
      const dateKey = new Date(msg.createdAt).toDateString();
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && new Date(lastGroup.messages[0].createdAt).toDateString() === dateKey) {
        lastGroup.messages.push(msg);
      } else {
        groups.push({ date: msg.createdAt, messages: [msg] });
      }
    }
    return groups;
  }, [messages]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior });
      wasAtBottomRef.current = true;
      setShowScrollBtn(false);
    }
  }, []);

  useEffect(() => {
    const wasAtBottom = wasAtBottomRef.current;
    const isNewMessage = messages.length > prevLengthRef.current;
    prevLengthRef.current = messages.length;
    if (isNewMessage && wasAtBottom) {
      scrollToBottom('smooth');
    } else if (isNewMessage && !wasAtBottom) {
      setShowScrollBtn(true);
    }
  }, [messages, scrollToBottom]);

  // Keep the typing bubble in view when the reader is already at the bottom
  useEffect(() => {
    if (typingText && wasAtBottomRef.current) {
      scrollToBottom('smooth');
    }
  }, [typingText, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    wasAtBottomRef.current = atBottom;
    setShowScrollBtn(!atBottom && messages.length > 0);

    if (el.scrollTop < 50 && hasMore && !loadingMore) {
      prevScrollHeightRef.current = el.scrollHeight;
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore, messages.length]);

  // Restore scroll position after loading more
  useEffect(() => {
    if (loadingMore || !prevScrollHeightRef.current) return;
    const el = viewportRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      if (el && prevScrollHeightRef.current) {
        const newHeight = el.scrollHeight;
        el.scrollTop = newHeight - prevScrollHeightRef.current;
        prevScrollHeightRef.current = 0;
      }
    });
  }, [loadingMore, messages]);

  if (loading) {
    return (
      <div className="chat-skel-list" aria-busy="true" aria-label="Cargando mensajes">
        <div className="chat-skel left" style={{ width: '38%' }} />
        <div className="chat-skel left tall" style={{ width: '56%' }} />
        <div className="chat-skel right" style={{ width: '32%' }} />
        <div className="chat-skel left" style={{ width: '44%' }} />
        <div className="chat-skel right tall" style={{ width: '50%' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="chat-messages-state error" role="alert">
        <div className="chat-messages-state-icon">
          <AlertCircle size={24} />
        </div>
        <div className="chat-messages-state-title">{error}</div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onLoadMore}
          icon={<RefreshCw size={14} />}
        >
          Reintentar
        </Button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="chat-messages-state">
        <div className="chat-messages-state-icon">
          <MessageCircle size={24} />
        </div>
        <div className="chat-messages-state-title">No hay mensajes aún</div>
        <div className="chat-messages-state-text">Escribe el primer mensaje</div>
      </div>
    );
  }

  return (
    <div className="chat-message-scroller relative flex-1 min-h-0">
      <ScrollArea
        className="h-full"
        onScroll={handleScroll}
      >
        <div ref={viewportRef} className="chat-thread min-h-full">
          {hasMore && (
            <div className="chat-load-more">
              {loadingMore ? 'Cargando...' : 'Desliza hacia arriba para ver más'}
            </div>
          )}
          {grouped.map((group, gi) => (
            <div key={gi} className="chat-date-group">
              <div className="chat-date-separator">
                <span>{formatDateLabel(group.date)}</span>
              </div>
              {group.messages.map((msg, mi) => {
                const prevMsg = mi > 0 ? group.messages[mi - 1] : null;
                const showAvatar =
                  !prevMsg ||
                  prevMsg.senderId !== msg.senderId ||
                  new Date(msg.createdAt).getTime() - new Date(prevMsg.createdAt).getTime() >
                    5 * 60 * 1000;
                return (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    isOwn={msg.senderId === currentUserId}
                    showAvatar={showAvatar}
                    senderName={msg.senderName}
                    onReply={() => onReply(msg)}
                    onReaction={onReaction}
                    onRemoveReaction={onRemoveReaction}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onForward={onForward}
                    onBookmark={onBookmark}
                    onUnbookmark={onUnbookmark}
                    onPin={onPin}
                    onUnpin={onUnpin}
                    onTranslate={onTranslate}
                    onVotePoll={onVotePoll}
                    onRsvpEvent={onRsvpEvent}
                    onOpenThread={onOpenThread}
                    channelId={channelId}
                    currentUserId={currentUserId}
                    isGroup={isGroup}
                  />
                );
              })}
            </div>
          ))}
          {typingText && (
            <div className="chat-msg-wrapper with-avatar chat-typing-row" aria-live="polite">
              {isGroup && (
                <div className="chat-msg-avatar" aria-hidden="true">
                  {typingText.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="chat-msg-content">
                {isGroup && <div className="chat-msg-sender">{typingText}</div>}
                <div className="chat-msg-bubble other chat-typing-bubble" aria-label={`${typingText} está escribiendo`}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {showScrollBtn && (
        <button
          type="button"
          className="chat-scroll-bottom"
          onClick={() => scrollToBottom('smooth')}
          aria-label="Ir al final"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </div>
  );
}

'use client';

import React, { useRef, useEffect, useMemo } from 'react';
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
  channelId: string;
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
  messages,
  loading,
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  currentUserId,
  onReply,
  onReaction,
  onRemoveReaction,
  onEdit,
  onDelete,
  onForward,
  channelId,
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);
  const wasAtBottomRef = useRef(true);

  // Group messages by date
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

  // Auto-scroll to bottom on new messages (if user was at bottom)
  useEffect(() => {
    const wasAtBottom = wasAtBottomRef.current;
    const isNewMessage = messages.length > prevLengthRef.current;
    prevLengthRef.current = messages.length;

    if (isNewMessage && wasAtBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Track scroll position
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    wasAtBottomRef.current = atBottom;

    // Load more when scrolled to top
    if (el.scrollTop < 50 && hasMore && !loadingMore) {
      const prevHeight = el.scrollHeight;
      onLoadMore();
      // Restore scroll position after load
      setTimeout(() => {
        if (el) {
          el.scrollTop = el.scrollHeight - prevHeight;
        }
      }, 50);
    }
  };

  if (loading) {
    return (
      <div className="chat-messages-loading">
        <div className="chat-skeleton-bubble left" />
        <div className="chat-skeleton-bubble right" />
        <div className="chat-skeleton-bubble left" />
      </div>
    );
  }

  if (error) {
    return <div className="chat-messages-error">{error}</div>;
  }

  if (messages.length === 0) {
    return (
      <div className="chat-messages-empty">
        <div className="chat-messages-empty-text">No hay mensajes aún</div>
        <div className="chat-messages-empty-hint">Escribe el primer mensaje</div>
      </div>
    );
  }

  return (
    <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
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
                channelId={channelId}
                currentUserId={currentUserId}
              />
            );
          })}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

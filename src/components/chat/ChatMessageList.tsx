'use client';

import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { ArrowDown, AlertCircle, RefreshCw } from 'lucide-react';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { Button } from '@/components/shadcn/button';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';
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
  onVotePoll, onRsvpEvent, onOpenThread, channelId,
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
      <div className="flex flex-col gap-3 p-4">
        <div className="flex gap-2 items-end">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-12 w-48 rounded-lg" />
        </div>
        <div className="flex gap-2 items-end justify-end">
          <Skeleton className="h-12 w-40 rounded-lg" />
        </div>
        <div className="flex gap-2 items-end">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-16 w-56 rounded-lg" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertCircle size={32} className="text-destructive" />
        <div className="text-sm text-destructive">{error}</div>
        <Button variant="outline" size="sm" onClick={onLoadMore}>
          <RefreshCw size={16} /> Reintentar
        </Button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="text-base font-medium text-foreground">No hay mensajes aún</div>
        <div className="text-sm text-muted-foreground">Escribe el primer mensaje</div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <ScrollArea
        className="h-full"
        onScroll={handleScroll}
      >
        <div ref={viewportRef} className="min-h-full">
          {hasMore && (
            <div className="py-2 text-center text-xs text-muted-foreground">
              {loadingMore ? 'Cargando...' : 'Desliza hacia arriba para ver más'}
            </div>
          )}
          {grouped.map((group, gi) => (
            <div key={gi} className="flex flex-col gap-1 px-3 py-1">
              <div className="flex justify-center py-2">
                <span className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                  {formatDateLabel(group.date)}
                </span>
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
                  />
                );
              })}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {showScrollBtn && (
        <Button
          variant="outline"
          size="icon"
          className={cn(
            'absolute bottom-4 right-4 z-10 size-10 rounded-full shadow-lg',
            'bg-background border-border hover:bg-accent'
          )}
          onClick={() => scrollToBottom('smooth')}
          aria-label="Ir al final"
        >
          <ArrowDown size={18} />
        </Button>
      )}
    </div>
  );
}

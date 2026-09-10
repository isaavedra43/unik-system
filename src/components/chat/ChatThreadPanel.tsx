'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { CornerUpRight, Send, Loader2, AlertCircle } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/shadcn/sheet';
import { Input } from '@/components/shadcn/input';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';
import type { ChatMessageDTO } from '@/modules/chat/chat-events';
import type { CurrentUser } from '@/modules/auth/authorization';

export interface ChatThreadPanelProps {
  threadId: string;
  rootMessage: ChatMessageDTO;
  channelId: string;
  user: CurrentUser;
  onClose: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ChatThreadPanel({ threadId, rootMessage, channelId, user, onClose }: ChatThreadPanelProps) {
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/threads/${threadId}/messages`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar el hilo');
      }
      const data = await res.json();
      setMessages(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const res = await fetch(`/app/chat/api/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: trimmed,
          replyToId: rootMessage.id,
          threadId,
        }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages((prev) => [...prev, msg]);
        setText('');
      }
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  }, [text, channelId, rootMessage.id, threadId]);

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 gap-0">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="flex items-center gap-2">
            <CornerUpRight size={18} /> Hilo de conversación
          </SheetTitle>
          <SheetDescription>
            {messages.length} {messages.length === 1 ? 'respuesta' : 'respuestas'}
          </SheetDescription>
        </SheetHeader>

        {/* Root message */}
        <div className="border-b border-border p-4 bg-muted/30">
          <div className="flex items-start gap-3">
            <Avatar className="size-8 shrink-0">
              <AvatarFallback className="text-xs font-semibold">
                {getInitials(rootMessage.senderName)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {rootMessage.senderName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatTime(rootMessage.createdAt)}
                </span>
              </div>
              <div className="text-sm text-foreground mt-0.5 break-words">
                {rootMessage.content ?? '[Archivo]'}
              </div>
            </div>
          </div>
        </div>

        {/* Thread messages */}
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-3 p-4">
            {loading && (
              <div className="flex flex-col gap-3">
                <div className="flex gap-2 items-end">
                  <Skeleton className="size-7 rounded-full" />
                  <Skeleton className="h-10 w-40 rounded-lg" />
                </div>
                <div className="flex gap-2 items-end justify-end">
                  <Skeleton className="h-10 w-32 rounded-lg" />
                </div>
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle size={16} /> {error}
              </div>
            )}
            {!loading && !error && messages.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No hay respuestas en este hilo todavía
              </div>
            )}
            {messages.map((msg) => {
              const isOwn = msg.senderId === user.id;
              return (
                <div
                  key={msg.id}
                  className={cn('flex gap-2', isOwn && 'flex-row-reverse')}
                >
                  <Avatar className="size-7 shrink-0">
                    <AvatarFallback className="text-[10px] font-semibold">
                      {getInitials(msg.senderName)}
                    </AvatarFallback>
                  </Avatar>
                  <div className={cn('flex flex-col gap-0.5 max-w-[80%]', isOwn && 'items-end')}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">{msg.senderName}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatTime(msg.createdAt)}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'rounded-lg px-3 py-1.5 text-sm break-words',
                        isOwn
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground'
                      )}
                    >
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="border-t border-border p-3 flex items-center gap-2">
          <Input
            type="text"
            placeholder="Responder en el hilo..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            aria-label="Responder en hilo"
            disabled={sending}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={sending || !text.trim()}
            aria-label="Enviar"
          >
            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

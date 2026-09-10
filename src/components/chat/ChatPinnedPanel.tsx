'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Pin, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/shadcn/dialog';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

export interface ChatPinnedPanelProps {
  channelId: string;
  onClose: () => void;
}

interface PinnedMessage {
  messageId: string;
  senderName: string;
  content: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatPinnedPanel({ channelId, onClose }: ChatPinnedPanelProps) {
  const [pinned, setPinned] = useState<PinnedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPinned = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/app/chat/api/channels/${channelId}/pin`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar mensajes fijados');
      }
      const data = await res.json();
      setPinned(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    loadPinned();
  }, [loadPinned]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin size={18} /> Mensajes fijados
          </DialogTitle>
          <DialogDescription>Mensajes destacados de esta conversación</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-2 pr-3">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 size={20} className="animate-spin" /> Cargando...
              </div>
            )}
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {!loading && !error && pinned.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No hay mensajes fijados
              </div>
            )}
            {pinned.map((msg) => (
              <div
                key={msg.messageId}
                className={cn(
                  'flex flex-col gap-1 rounded-md border border-border p-3',
                  'transition-colors hover:bg-accent'
                )}
              >
                <span className="text-sm font-semibold text-foreground">{msg.senderName}</span>
                <span className="text-sm text-muted-foreground line-clamp-3">
                  {msg.content?.slice(0, 200) ?? '[Archivo]'}
                </span>
                <span className="text-xs text-muted-foreground">{formatDate(msg.createdAt)}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import React, { useState, useEffect } from 'react';
import { Check, CheckCheck, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/shadcn/dialog';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { cn } from '@/lib/utils';

export interface ChatReadReceiptsDialogProps {
  messageId: string;
  sentAt?: string;
  onClose: () => void;
}

interface Reader {
  userId: string;
  name: string;
  readAt: string;
}

export function ChatReadReceiptsDialog({ messageId, sentAt, onClose }: ChatReadReceiptsDialogProps) {
  const [readers, setReaders] = useState<Reader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/app/chat/api/messages/${messageId}/readers`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Error al cargar lecturas');
        }
        const data = await res.json();
        if (!cancelled) setReaders(data.data ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const formatTime = (iso: string) =>
    new Date(iso).toLocaleString('es-MX', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCheck size={18} /> Detalles del mensaje
          </DialogTitle>
          <DialogDescription>Entrega y lectura de este mensaje</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[50vh]">
          <div className="flex flex-col gap-1 pr-3">
            {sentAt && (
              <div className="chat-receipt-sent">
                <span className="chat-receipt-sent-icon" aria-hidden="true">
                  <Check size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground">Enviado</div>
                  <div className="text-xs text-muted-foreground">{formatTime(sentAt)}</div>
                </div>
              </div>
            )}
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
            {!loading && !error && readers.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nadie ha leído este mensaje todavía
              </div>
            )}
            {readers.map((r) => (
              <div
                key={r.userId}
                className={cn(
                  'flex items-center gap-3 rounded-md p-2',
                  'transition-colors hover:bg-accent'
                )}
              >
                <Avatar className="size-8">
                  <AvatarFallback className="text-xs font-semibold">
                    {r.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Visto · {formatTime(r.readAt)}
                  </div>
                </div>
                <CheckCheck size={16} className="chat-receipt-seen-icon shrink-0" />
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

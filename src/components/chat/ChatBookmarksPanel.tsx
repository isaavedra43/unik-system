'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Bookmark, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/shadcn/dialog';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

export interface ChatBookmarksPanelProps {
  onClose: () => void;
}

interface BookmarkMessage {
  messageId: string;
  senderName: string;
  content: string;
  channelName?: string | null;
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

export function ChatBookmarksPanel({ onClose }: ChatBookmarksPanelProps) {
  const [bookmarks, setBookmarks] = useState<BookmarkMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBookmarks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/bookmarks');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al cargar marcadores');
      }
      const data = await res.json();
      setBookmarks(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bookmark size={18} /> Marcadores
          </DialogTitle>
          <DialogDescription>Tus mensajes guardados</DialogDescription>
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
            {!loading && !error && bookmarks.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No tienes marcadores
              </div>
            )}
            {bookmarks.map((msg) => (
              <div
                key={msg.messageId}
                className={cn(
                  'flex flex-col gap-1 rounded-md border border-border p-3',
                  'transition-colors hover:bg-accent'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{msg.senderName}</span>
                  {msg.channelName && (
                    <span className="text-xs text-primary">{msg.channelName}</span>
                  )}
                </div>
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

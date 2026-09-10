'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/shadcn/dialog';
import { Input } from '@/components/shadcn/input';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

export interface ChatSearchDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectChannel: (channelId: string) => void;
}

interface SearchResult {
  messageId: string;
  channelId: string;
  channelName: string;
  senderName: string;
  content: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function ChatSearchDialog({ open, onClose, onSelectChannel }: ChatSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/app/chat/api/search?query=${encodeURIComponent(trimmed)}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Error en la búsqueda');
        }
        const data = await res.json();
        setResults(Array.isArray(data.data) ? data.data : []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error en la búsqueda');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, open]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      onSelectChannel(result.channelId);
      onClose();
    },
    [onSelectChannel, onClose]
  );

  const handleClose = useCallback(() => {
    setQuery('');
    setResults([]);
    setError(null);
    onClose();
  }, [onClose]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Buscar mensajes</DialogTitle>
          <DialogDescription>Busca en todas tus conversaciones</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Escribe para buscar..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
          />
          {loading && (
            <Loader2
              size={18}
              className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground"
            />
          )}
        </div>

        <ScrollArea className="max-h-[50vh]">
          <div className="flex flex-col gap-1 pr-3">
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {!error && !loading && query.trim().length >= 2 && results.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No se encontraron mensajes
              </div>
            )}
            {!error && query.trim().length < 2 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Escribe al menos 2 caracteres
              </div>
            )}
            {results.map((result) => (
              <button
                key={result.messageId}
                type="button"
                className={cn(
                  'flex flex-col gap-1 rounded-md p-3 text-left transition-colors',
                  'hover:bg-accent focus:bg-accent focus:outline-none'
                )}
                onClick={() => handleSelect(result)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-primary">{result.channelName}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(result.createdAt)}</span>
                </div>
                <span className="text-xs font-medium text-foreground">{result.senderName}</span>
                <span className="text-sm text-muted-foreground line-clamp-2">
                  {result.content.slice(0, 120)}
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

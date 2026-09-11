'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Send, Loader2, Megaphone, AlertCircle, Check, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/shadcn/dialog';
import { Textarea } from '@/components/shadcn/textarea';
import { Button } from '@/components/shadcn/button';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

interface Channel {
  id: string;
  name: string | null;
  type: string;
  members?: { name: string; userId: string }[];
}

export interface ChatBroadcastDialogProps {
  onClose: () => void;
  onSent: () => void;
}

function getChannelDisplayName(c: Channel): string {
  if (c.name) return c.name;
  if (c.type === 'group') return 'Grupo';
  // DM — derive name from the other member
  const otherMember = c.members?.[0];
  return otherMember?.name ?? 'Chat';
}

export function ChatBroadcastDialog({ onClose, onSent }: ChatBroadcastDialogProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/app/chat/api/channels');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setChannels(data.data ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 5) next.add(id);
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || selected.size === 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/app/chat/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelIds: Array.from(selected),
          content: trimmed,
          priority,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Error al difundir');
      }
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSending(false);
    }
  }, [content, selected, priority, onSent, onClose]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone size={18} /> Difundir a canales
          </DialogTitle>
          <DialogDescription>Envía un mensaje a múltiples conversaciones (máx. 5)</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              Selecciona canales ({selected.size}/5)
            </label>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 size={20} className="animate-spin" /> Cargando...
              </div>
            ) : (
              <ScrollArea className="max-h-[30vh]">
                <div className="flex flex-col gap-1 pr-3">
                  {channels.map((c) => {
                    const isSelected = selected.has(c.id);
                    const displayName = getChannelDisplayName(c);
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
                            {c.type === 'group' ? (
                              <Users size={14} />
                            ) : (
                              displayName.slice(0, 2).toUpperCase()
                            )}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 text-sm font-medium text-foreground truncate">
                          {displayName}
                        </span>
                        {isSelected && <Check size={18} className="text-primary shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">Mensaje</label>
            <Textarea
              placeholder="Escribe el mensaje a difundir..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              maxLength={10000}
              aria-label="Mensaje a difundir"
            />
            <span className="text-xs text-muted-foreground text-right">
              {content.length}/10000
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">Prioridad</label>
            <div className="flex gap-2">
              <Button
                variant={priority === 'normal' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPriority('normal')}
              >
                Normal
              </Button>
              <Button
                variant={priority === 'urgent' ? 'destructive' : 'outline'}
                size="sm"
                onClick={() => setPriority('urgent')}
              >
                <AlertCircle size={14} /> Urgente
              </Button>
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={sending || selected.size === 0 || !content.trim()}
            onClick={handleSend}
          >
            {sending ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Difundiendo...
              </>
            ) : (
              <>
                <Send size={16} /> Difundir{selected.size > 0 ? ` (${selected.size})` : ''}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

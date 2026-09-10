'use client';

import React, { useState, useEffect } from 'react';
import {
  MessageSquare, Paperclip, Smile, Users, Calendar as CalendarIcon,
  TrendingUp, Loader2, BarChart3,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/shadcn/dialog';
import { Avatar, AvatarFallback } from '@/components/shadcn/avatar';
import { ScrollArea } from '@/components/shadcn/scroll-area';
import { cn } from '@/lib/utils';

interface PersonalStats {
  totalMessages: number;
  totalAttachments: number;
  totalReactions: number;
  activeChannels: number;
  activeDays: number;
  messagesToday: number;
  messages7d: number;
  messages30d: number;
  activityByDay: { date: string; count: number }[];
  topContacts: { userId: string; name: string; messageCount: number }[];
  messagesByHour: { hour: number; count: number }[];
}

export interface ChatPersonalStatsProps {
  onClose: () => void;
}

export function ChatPersonalStats({ onClose }: ChatPersonalStatsProps) {
  const [stats, setStats] = useState<PersonalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/app/chat/api/stats');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Error al cargar estadísticas');
        }
        const data = await res.json();
        if (!cancelled) setStats(data.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const maxActivity = stats ? Math.max(...stats.activityByDay.map((d) => d.count), 1) : 1;
  const maxHour = stats ? Math.max(...stats.messagesByHour.map((h) => h.count), 1) : 1;

  const summaryCards = stats ? [
    { icon: MessageSquare, value: stats.totalMessages, label: 'Mensajes enviados' },
    { icon: Users, value: stats.activeChannels, label: 'Canales activos' },
    { icon: CalendarIcon, value: stats.activeDays, label: 'Días activos (30d)' },
    { icon: Paperclip, value: stats.totalAttachments, label: 'Adjuntos enviados' },
    { icon: Smile, value: stats.totalReactions, label: 'Reacciones dadas' },
    { icon: TrendingUp, value: stats.messagesToday, label: 'Mensajes hoy' },
  ] : [];

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 size={18} /> Mis estadísticas
          </DialogTitle>
          <DialogDescription>Tu actividad en el chat</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 size={24} className="animate-spin" /> Cargando estadísticas...
          </div>
        )}
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}

        {stats && !loading && (
          <ScrollArea className="max-h-[60vh]">
            <div className="flex flex-col gap-4 pr-3">
              <div className="grid grid-cols-3 gap-2">
                {summaryCards.map((card, i) => (
                  <div
                    key={i}
                    className="flex flex-col items-center gap-1 rounded-lg border border-border bg-card p-3 text-center"
                  >
                    <card.icon size={18} className="text-primary" />
                    <div className="text-lg font-bold text-foreground">{card.value}</div>
                    <div className="text-[11px] text-muted-foreground">{card.label}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">Actividad últimos 30 días</h3>
                <div className="flex items-end gap-0.5 h-24">
                  {stats.activityByDay.map((d) => (
                    <div
                      key={d.date}
                      className="flex-1 rounded-t bg-primary/30 hover:bg-primary/50 transition-colors min-h-[2px]"
                      style={{ height: `${(d.count / maxActivity) * 100}%` }}
                      title={`${d.date}: ${d.count} mensajes`}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">Actividad por hora</h3>
                <div className="flex items-end gap-0.5 h-20">
                  {stats.messagesByHour.map((h) => (
                    <div
                      key={h.hour}
                      className="flex-1 rounded-t bg-info/30 hover:bg-info/50 transition-colors min-h-[2px]"
                      style={{ height: `${(h.count / maxHour) * 100}%` }}
                      title={`${h.hour}:00 - ${h.count} mensajes`}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">Contactos frecuentes</h3>
                {stats.topContacts.length === 0 ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    Sin contactos frecuentes aún
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {stats.topContacts.map((c, i) => (
                      <div
                        key={c.userId}
                        className={cn(
                          'flex items-center gap-3 rounded-md p-2',
                          'transition-colors hover:bg-accent'
                        )}
                      >
                        <span className="text-sm font-bold text-muted-foreground w-5">{i + 1}</span>
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs font-semibold">
                            {c.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 text-sm font-medium text-foreground truncate">
                          {c.name}
                        </span>
                        <span className="text-sm text-muted-foreground">{c.messageCount}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

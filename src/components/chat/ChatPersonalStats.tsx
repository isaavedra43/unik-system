'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  MessageSquare,
  Paperclip,
  Smile,
  Users,
  Calendar,
  TrendingUp,
  Loader2,
  BarChart3,
} from 'lucide-react';

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
    return () => {
      cancelled = true;
    };
  }, []);

  const maxActivity = stats ? Math.max(...stats.activityByDay.map((d) => d.count), 1) : 1;
  const maxHour = stats ? Math.max(...stats.messagesByHour.map((h) => h.count), 1) : 1;

  return (
    <div className="chat-dialog-overlay" onClick={onClose}>
      <div className="chat-personal-stats" onClick={(e) => e.stopPropagation()}>
        <div className="chat-dialog-header">
          <h2>
            <BarChart3 size={20} /> Mis estadísticas
          </h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X size={20} />
          </button>
        </div>

        {loading && (
          <div className="chat-panel-loading">
            <Loader2 size={24} className="spin" /> Cargando estadísticas...
          </div>
        )}
        {error && <div className="chat-dialog-error">{error}</div>}

        {stats && !loading && (
          <>
            {/* Summary cards */}
            <div className="chat-stats-grid">
              <div className="chat-stat-card">
                <MessageSquare size={20} />
                <div className="chat-stat-value">{stats.totalMessages}</div>
                <div className="chat-stat-label">Mensajes enviados</div>
              </div>
              <div className="chat-stat-card">
                <Users size={20} />
                <div className="chat-stat-value">{stats.activeChannels}</div>
                <div className="chat-stat-label">Canales activos</div>
              </div>
              <div className="chat-stat-card">
                <Calendar size={20} />
                <div className="chat-stat-value">{stats.activeDays}</div>
                <div className="chat-stat-label">Días activos (30d)</div>
              </div>
              <div className="chat-stat-card">
                <Paperclip size={20} />
                <div className="chat-stat-value">{stats.totalAttachments}</div>
                <div className="chat-stat-label">Adjuntos enviados</div>
              </div>
              <div className="chat-stat-card">
                <Smile size={20} />
                <div className="chat-stat-value">{stats.totalReactions}</div>
                <div className="chat-stat-label">Reacciones dadas</div>
              </div>
              <div className="chat-stat-card">
                <TrendingUp size={20} />
                <div className="chat-stat-value">{stats.messagesToday}</div>
                <div className="chat-stat-label">Mensajes hoy</div>
              </div>
            </div>

            {/* Activity chart */}
            <div className="chat-stats-section">
              <h3>Actividad últimos 30 días</h3>
              <div className="chat-stats-chart">
                {stats.activityByDay.map((d) => (
                  <div
                    key={d.date}
                    className="chat-stats-bar"
                    style={{ height: `${(d.count / maxActivity) * 100}%` }}
                    title={`${d.date}: ${d.count} mensajes`}
                  >
                    <span className="chat-stats-bar-count">{d.count > 0 ? d.count : ''}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Activity by hour */}
            <div className="chat-stats-section">
              <h3>Actividad por hora</h3>
              <div className="chat-stats-chart hourly">
                {stats.messagesByHour.map((h) => (
                  <div
                    key={h.hour}
                    className="chat-stats-bar"
                    style={{ height: `${(h.count / maxHour) * 100}%` }}
                    title={`${h.hour}:00 - ${h.count} mensajes`}
                  />
                ))}
              </div>
              <div className="chat-stats-hours-labels">
                <span>0h</span>
                <span>6h</span>
                <span>12h</span>
                <span>18h</span>
                <span>23h</span>
              </div>
            </div>

            {/* Top contacts */}
            <div className="chat-stats-section">
              <h3>Contactos frecuentes</h3>
              {stats.topContacts.length === 0 ? (
                <div className="chat-dialog-empty">Sin contactos frecuentes aún</div>
              ) : (
                <div className="chat-stats-contacts">
                  {stats.topContacts.map((c, i) => (
                    <div key={c.userId} className="chat-stats-contact">
                      <span className="chat-stats-contact-rank">{i + 1}</span>
                      <div className="chat-stats-contact-avatar">
                        {c.name.slice(0, 2).toUpperCase()}
                      </div>
                      <span className="chat-stats-contact-name">{c.name}</span>
                      <span className="chat-stats-contact-count">{c.messageCount}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  Hash,
  AtSign,
  MessageSquare,
  Users,
  Calendar,
  BarChart3,
} from 'lucide-react';
import { ChatAdminStatCard } from './ChatAdminStatCard';

interface StatsData {
  stats: {
    totalChannels: number;
    totalMessages: number;
    messages24h: number;
    activeUsers24h: number;
    polls: number;
    events: number;
    unreadMentions: number;
    activeAlerts: number;
  };
  byDay: Array<{ date: string; messages: number }>;
  topUsers: Array<{
    userId: string;
    userName: string;
    messageCount: number;
    channelCount: number;
  }>;
}

export function ChatAdminOverview() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/admin/chat/api/stats');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading && !data) return <div className="chat-admin-loading">Cargando…</div>;
  if (!data) return <div className="chat-admin-error">No se pudieron cargar las estadísticas</div>;

  const s = data.stats;
  const maxMessages = Math.max(...data.byDay.map((d) => d.messages), 1);

  return (
    <div className="chat-admin-overview">
      <div className="chat-admin-stat-grid">
        <ChatAdminStatCard
          label="Total canales"
          value={s.totalChannels.toLocaleString('es-MX')}
          icon={<Hash size={20} />}
        />
        <ChatAdminStatCard
          label="Total mensajes"
          value={s.totalMessages.toLocaleString('es-MX')}
          icon={<MessageSquare size={20} />}
        />
        <ChatAdminStatCard
          label="Mensajes 24h"
          value={s.messages24h.toLocaleString('es-MX')}
          icon={<Activity size={20} />}
        />
        <ChatAdminStatCard
          label="Usuarios activos 24h"
          value={s.activeUsers24h.toLocaleString('es-MX')}
          icon={<Users size={20} />}
        />
        <ChatAdminStatCard
          label="Encuestas"
          value={s.polls.toLocaleString('es-MX')}
          icon={<BarChart3 size={20} />}
        />
        <ChatAdminStatCard
          label="Eventos"
          value={s.events.toLocaleString('es-MX')}
          icon={<Calendar size={20} />}
        />
        <ChatAdminStatCard
          label="Menciones no leídas"
          value={s.unreadMentions.toLocaleString('es-MX')}
          icon={<AtSign size={20} />}
          tone={s.unreadMentions > 0 ? 'warning' : 'default'}
        />
        <ChatAdminStatCard
          label="Alertas activas"
          value={s.activeAlerts.toLocaleString('es-MX')}
          icon={<AlertTriangle size={20} />}
          tone={s.activeAlerts > 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="chat-admin-section">
        <h3 className="chat-admin-section-title">Mensajes por día (30 días)</h3>
        <div className="chat-admin-chart">
          {data.byDay.length === 0 && <div className="chat-admin-empty">Sin datos</div>}
          {data.byDay.map((d) => (
            <div
              key={d.date}
              className="chat-admin-chart-bar"
              title={`${d.date}: ${d.messages} mensajes`}
            >
              <div
                className="chat-admin-chart-bar-fill"
                style={{ height: `${(d.messages / maxMessages) * 100}%` }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="chat-admin-section">
        <h3 className="chat-admin-section-title">Usuarios más activos</h3>
        <div className="chat-admin-list">
          {data.topUsers.length === 0 && <div className="chat-admin-empty">Sin datos</div>}
          {data.topUsers.map((u) => (
            <div key={u.userId} className="chat-admin-list-item">
              <span className="chat-admin-list-name">{u.userName}</span>
              <span className="chat-admin-list-count">{u.messageCount} msgs</span>
              <span className="chat-admin-list-meta">{u.channelCount} canales</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

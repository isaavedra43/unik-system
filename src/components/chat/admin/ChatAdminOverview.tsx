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
    totalDmChannels: number;
    totalGroupChannels: number;
    totalMessages: number;
    totalAttachments: number;
    activeUsers24h: number;
    activeUsers7d: number;
    messages24h: number;
    messages7d: number;
    messages30d: number;
    totalPolls: number;
    totalEvents: number;
    totalMentions: number;
    unreadMentions: number;
    activeAlerts: number;
  };
  activity: Array<{ date: string; messages: number }>;
  topUsers: Array<{
    userId: string;
    userName: string;
    messageCount: number;
    attachmentCount: number;
    lastActivity: string | null;
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
  const maxMessages = Math.max(...data.activity.map((d) => d.messages), 1);

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
          value={s.totalPolls.toLocaleString('es-MX')}
          icon={<BarChart3 size={20} />}
        />
        <ChatAdminStatCard
          label="Eventos"
          value={s.totalEvents.toLocaleString('es-MX')}
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
          {data.activity.length === 0 && <div className="chat-admin-empty">Sin datos</div>}
          {data.activity.map((d) => (
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
        <div className="chat-admin-chart-labels">
          <span>{data.activity[0]?.date.slice(5) ?? ''}</span>
          <span>{data.activity[Math.floor(data.activity.length / 2)]?.date.slice(5) ?? ''}</span>
          <span>{data.activity[data.activity.length - 1]?.date.slice(5) ?? ''}</span>
        </div>
      </div>

      <div className="chat-admin-section">
        <h3 className="chat-admin-section-title">Usuarios más activos</h3>
        <div className="chat-admin-list">
          {data.topUsers.length === 0 && <div className="chat-admin-empty">Sin datos</div>}
          {data.topUsers.map((u, idx) => (
            <div key={u.userId} className="chat-admin-list-item">
              <span className="chat-admin-list-rank">#{idx + 1}</span>
              <span className="chat-admin-list-avatar">
                {u.userName.slice(0, 2).toUpperCase()}
              </span>
              <span className="chat-admin-list-name">{u.userName}</span>
              <span className="chat-admin-list-count">{u.messageCount} msgs</span>
              <span className="chat-admin-list-meta">{u.attachmentCount} adjuntos</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

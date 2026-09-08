'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Activity, DollarSign, MessageSquare, Users, Zap } from 'lucide-react';
import { AssistantAdminStatCard } from './AssistantAdminStatCard';

interface StatsData {
  stats: {
    totalConversations: number;
    totalMessages: number;
    totalToolCalls: number;
    totalApiCalls: number;
    totalTokens: number;
    estimatedCostUsd: number;
    activeUsers24h: number;
    activeUsers7d: number;
    successRate: number;
    errorCount: number;
    last24hMessages: number;
    last24hTokens: number;
  };
  byDay: Array<{ date: string; messages: number; tokens: number; cost: number }>;
  topTools: Array<{ toolName: string; count: number; successRate: number; avgDurationMs: number }>;
  topUsers: Array<{ userId: string; userName: string; messageCount: number; tokenCount: number }>;
}

export function AssistantAdminOverview() {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/admin/assistant/api/stats');
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
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading && !data) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!data) return <div className="assistant-admin-error">No se pudieron cargar las estadísticas</div>;

  const s = data.stats;
  const maxTokens = Math.max(...data.byDay.map((d) => d.tokens), 1);

  return (
    <div className="assistant-admin-overview">
      <div className="assistant-admin-stat-grid">
        <AssistantAdminStatCard
          label="Conversaciones"
          value={s.totalConversations.toLocaleString('es-MX')}
          icon={<MessageSquare size={20} />}
        />
        <AssistantAdminStatCard
          label="Mensajes"
          value={s.totalMessages.toLocaleString('es-MX')}
          hint={`${s.last24hMessages} en 24h`}
          icon={<Activity size={20} />}
        />
        <AssistantAdminStatCard
          label="Tokens consumidos"
          value={s.totalTokens.toLocaleString('es-MX')}
          hint={`${s.last24hTokens.toLocaleString('es-MX')} en 24h`}
          icon={<Zap size={20} />}
        />
        <AssistantAdminStatCard
          label="Costo estimado"
          value={`$${s.estimatedCostUsd.toFixed(4)} USD`}
          icon={<DollarSign size={20} />}
        />
        <AssistantAdminStatCard
          label="Usuarios activos 24h"
          value={s.activeUsers24h}
          hint={`${s.activeUsers7d} en 7 días`}
          icon={<Users size={20} />}
        />
        <AssistantAdminStatCard
          label="Tasa de éxito"
          value={`${s.successRate.toFixed(1)}%`}
          hint={`${s.errorCount} errores`}
          tone={s.successRate > 95 ? 'success' : s.successRate > 80 ? 'warning' : 'danger'}
        />
      </div>

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Uso por día (30 días)</h3>
        <div className="assistant-admin-chart">
          {data.byDay.length === 0 && <div className="assistant-admin-empty">Sin datos</div>}
          {data.byDay.map((d) => (
            <div key={d.date} className="assistant-admin-chart-bar" title={`${d.date}: ${d.tokens} tokens`}>
              <div
                className="assistant-admin-chart-bar-fill"
                style={{ height: `${(d.tokens / maxTokens) * 100}%` }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Tools más usados</h3>
        <div className="assistant-admin-list">
          {data.topTools.length === 0 && <div className="assistant-admin-empty">Sin datos</div>}
          {data.topTools.map((t) => (
            <div key={t.toolName} className="assistant-admin-list-item">
              <span className="assistant-admin-list-name">{t.toolName}</span>
              <span className="assistant-admin-list-count">{t.count}x</span>
              <span className="assistant-admin-list-meta">
                {t.successRate.toFixed(0)}% éxito · {t.avgDurationMs}ms
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Usuarios más activos</h3>
        <div className="assistant-admin-list">
          {data.topUsers.length === 0 && <div className="assistant-admin-empty">Sin datos</div>}
          {data.topUsers.map((u) => (
            <div key={u.userId} className="assistant-admin-list-item">
              <span className="assistant-admin-list-name">{u.userName}</span>
              <span className="assistant-admin-list-count">{u.messageCount} msgs</span>
              <span className="assistant-admin-list-meta">
                {u.tokenCount.toLocaleString('es-MX')} tokens
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

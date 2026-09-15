'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Activity, CheckCircle2, DollarSign, MessageSquare, ShieldCheck, Star, ThumbsUp, Users, Zap } from 'lucide-react';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { successRateTone } from '@/components/patterns/dashboard/dashboard-utils';

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
  feedback?: {
    days: number;
    up: number;
    down: number;
    total: number;
    helpfulRate: number;
    judged: number;
    avgJudgeScore: number | null;
    verifiedShare: number | null;
    recentComments: Array<{ messageId: string; rating: number; comment: string; createdAt: string }>;
  } | null;
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
      <KpiGrid columns={3} className="mb-6">
        <StatCard
          label="Conversaciones"
          value={s.totalConversations.toLocaleString('es-MX')}
          icon={<MessageSquare size={20} />}
        />
        <StatCard
          label="Mensajes"
          value={s.totalMessages.toLocaleString('es-MX')}
          hint={`${s.last24hMessages} en 24h`}
          icon={<Activity size={20} />}
        />
        <StatCard
          label="Tokens consumidos"
          value={s.totalTokens.toLocaleString('es-MX')}
          hint={`${s.last24hTokens.toLocaleString('es-MX')} en 24h`}
          icon={<Zap size={20} />}
        />
        <StatCard
          label="Costo estimado"
          value={`$${s.estimatedCostUsd.toFixed(4)} USD`}
          icon={<DollarSign size={20} />}
        />
        <StatCard
          label="Usuarios activos 24h"
          value={s.activeUsers24h}
          hint={`${s.activeUsers7d} en 7 días`}
          icon={<Users size={20} />}
        />
        <StatCard
          label="Tasa de éxito"
          value={`${s.successRate.toFixed(1)}%`}
          hint={`${s.errorCount} errores`}
          icon={<CheckCircle2 size={20} />}
          tone={successRateTone(s.successRate)}
        />
      </KpiGrid>

      {data.feedback && (
        <div className="assistant-admin-section">
          <h3 className="assistant-admin-section-title">Calidad de respuestas (30 días)</h3>
          <KpiGrid columns={3} className="mb-6">
            <StatCard
              label="Respuestas útiles"
              value={data.feedback.total > 0 ? `${data.feedback.helpfulRate.toFixed(0)}%` : '—'}
              hint={`${data.feedback.up} 👍 · ${data.feedback.down} 👎`}
              icon={<ThumbsUp size={20} />}
              tone={data.feedback.total === 0 ? 'default' : data.feedback.helpfulRate >= 85 ? 'success' : data.feedback.helpfulRate >= 60 ? 'warning' : 'danger'}
            />
            <StatCard
              label="Juez automático"
              value={data.feedback.avgJudgeScore != null ? `${data.feedback.avgJudgeScore.toFixed(2)} / 5` : 'Apagado'}
              hint={data.feedback.judged > 0 ? `${data.feedback.judged} respuestas evaluadas` : 'Actívalo en Configuración'}
              icon={<Star size={20} />}
            />
            <StatCard
              label="Con datos verificados"
              value={data.feedback.verifiedShare != null ? `${data.feedback.verifiedShare.toFixed(0)}%` : '—'}
              hint="Respuestas respaldadas por tools del mismo turno"
              icon={<ShieldCheck size={20} />}
            />
          </KpiGrid>
          {data.feedback.recentComments.length > 0 && (
            <div className="assistant-admin-list">
              {data.feedback.recentComments.map((c) => (
                <div key={c.messageId} className="assistant-admin-list-item">
                  <span className="assistant-admin-list-name">{c.rating === 1 ? '👍' : '👎'} {c.comment}</span>
                  <span className="assistant-admin-list-meta">{new Date(c.createdAt).toLocaleString('es-MX')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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

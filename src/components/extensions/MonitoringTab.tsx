'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  TrendingUp,
  XCircle,
  Zap,
} from 'lucide-react';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtensionRow {
  id: string;
  namespace: string;
  kind: string;
  name: string;
  status: string;
  allowedHosts: string[];
  updatedAt: string;
  counts: { capabilities: number; connections: number; executions: number };
}

interface ExecutionRow {
  id: string;
  extensionId: string | null;
  toolName: string;
  status: string;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
  userId: string | null;
  createdAt: string;
}

interface UsageRow {
  key: string;
  period: string;
  unit: string;
  count: number;
  amount: string;
}

interface HealthSummary {
  extensionId: string;
  total: number;
  success: number;
  failed: number;
  errorRate: number;
  avgLatencyMs: number;
  lastCallAt: string | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MonitoringTab({ extensions }: { extensions: ExtensionRow[] }) {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadData = useCallback(async () => {
    setRefreshing(true);
    try {
      const [execRes, usageRes] = await Promise.all([
        fetch('/app/admin/extensions/api/executions?limit=500').then((r) => r.json()),
        fetch('/app/admin/extensions/api/usage?dimension=extension').then((r) => r.json()),
      ]);
      setExecutions(execRes.executions ?? []);
      setUsage(usageRes.usage ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 15s when enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadData]);

  // Build health summaries per extension
  const healthSummaries: HealthSummary[] = React.useMemo(() => {
    return extensions.map((ext) => {
      const extExecs = executions.filter((e) => e.extensionId === ext.id);
      const total = extExecs.length;
      const success = extExecs.filter((e) => e.status === 'executed' || e.status === 'success').length;
      const failed = extExecs.filter(
        (e) => e.status === 'failed' || e.status === 'error' || e.status === 'timeout'
      ).length;
      const errorRate = total > 0 ? (failed / total) * 100 : 0;
      const avgLatencyMs =
        total > 0
          ? Math.round(extExecs.reduce((sum, e) => sum + e.durationMs, 0) / total)
          : 0;
      const lastCall = extExecs[0]?.createdAt ?? null;
      const lastErrorExec = extExecs.find(
        (e) => e.status === 'failed' || e.status === 'error' || e.status === 'timeout'
      );
      return {
        extensionId: ext.id,
        total,
        success,
        failed,
        errorRate,
        avgLatencyMs,
        lastCallAt: lastCall,
        lastError: lastErrorExec?.errorMessage ?? lastErrorExec?.errorCode ?? null,
      };
    });
  }, [extensions, executions]);

  // Overall stats
  const overall = React.useMemo(() => {
    const totalCalls = executions.length;
    const totalSuccess = executions.filter(
      (e) => e.status === 'executed' || e.status === 'success'
    ).length;
    const totalFailed = executions.filter(
      (e) => e.status === 'failed' || e.status === 'error' || e.status === 'timeout'
    ).length;
    const avgLatency =
      totalCalls > 0
        ? Math.round(executions.reduce((sum, e) => sum + e.durationMs, 0) / totalCalls)
        : 0;
    return { totalCalls, totalSuccess, totalFailed, avgLatency };
  }, [executions]);

  const recentErrors = executions
    .filter((e) => e.status === 'failed' || e.status === 'error' || e.status === 'timeout')
    .slice(0, 10);

  if (loading) return <div className="assistant-admin-loading">Cargando monitoreo…</div>;

  return (
    <div className="monitoring-tab">
      {/* Toolbar */}
      <div className="monitoring-toolbar">
        <div className="monitoring-toolbar-left">
          <Activity size={18} />
          <h3 className="monitoring-title">Monitoreo en tiempo real</h3>
        </div>
        <div className="monitoring-toolbar-right">
          <label className="monitoring-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (15s)
          </label>
          <button
            type="button"
            className="monitoring-refresh-btn"
            onClick={loadData}
            disabled={refreshing}
            aria-label="Actualizar"
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            Actualizar
          </button>
        </div>
      </div>

      {/* Overall stats */}
      <KpiGrid columns={4}>
        <StatCard icon={<Zap size={20} />} label="Llamadas totales" value={overall.totalCalls} />
        <StatCard
          icon={<CheckCircle2 size={20} />}
          label="Exitosas"
          value={overall.totalSuccess}
          tone={overall.totalSuccess > 0 ? 'success' : 'default'}
        />
        <StatCard
          icon={<XCircle size={20} />}
          label="Fallidas"
          value={overall.totalFailed}
          tone={overall.totalFailed > 0 ? 'danger' : 'default'}
        />
        {/* Sin umbral de latencia definido: métrica neutra, sin tono de estado. */}
        <StatCard
          icon={<Clock size={20} />}
          label="Latencia promedio"
          value={`${overall.avgLatency} ms`}
        />
      </KpiGrid>

      {/* Per-extension health */}
      <div className="monitoring-section">
        <h4 className="monitoring-section-title">Salud por extensión</h4>
        {extensions.length === 0 ? (
          <p className="assistant-admin-muted">Sin extensiones instaladas.</p>
        ) : (
          <div className="monitoring-table-wrap">
            <table className="monitoring-table">
              <thead>
                <tr>
                  <th>Extensión</th>
                  <th>Estado</th>
                  <th>Llamadas</th>
                  <th>Exitosas</th>
                  <th>Fallidas</th>
                  <th>Error %</th>
                  <th>Latencia</th>
                  <th>Última llamada</th>
                  <th>Último error</th>
                </tr>
              </thead>
              <tbody>
                {extensions.map((ext) => {
                  const health = healthSummaries.find((h) => h.extensionId === ext.id);
                  const healthStatus = !health || health.total === 0
                    ? 'idle'
                    : health.errorRate > 20
                    ? 'critical'
                    : health.errorRate > 5
                    ? 'warning'
                    : 'healthy';
                  return (
                    <tr key={ext.id}>
                      <td>
                        <div className="monitoring-ext-name">{ext.name}</div>
                        <div className="monitoring-ext-ns">{ext.namespace}</div>
                      </td>
                      <td>
                        <span className={`monitoring-health-badge monitoring-health-${healthStatus}`}>
                          {healthStatus === 'healthy' && <CheckCircle2 size={12} />}
                          {healthStatus === 'warning' && <AlertTriangle size={12} />}
                          {healthStatus === 'critical' && <XCircle size={12} />}
                          {healthStatus === 'idle' && <Clock size={12} />}
                          {healthStatus === 'idle' ? 'inactiva' : healthStatus === 'healthy' ? 'saludable' : healthStatus === 'warning' ? 'advertencia' : 'crítica'}
                        </span>
                      </td>
                      <td>{health?.total ?? 0}</td>
                      <td className="monitoring-cell-success">{health?.success ?? 0}</td>
                      <td className="monitoring-cell-error">{health?.failed ?? 0}</td>
                      <td>
                        <span className={`monitoring-error-rate ${health && health.errorRate > 5 ? 'high' : ''}`}>
                          {(health?.errorRate ?? 0).toFixed(1)}%
                        </span>
                      </td>
                      <td>{health?.avgLatencyMs ?? 0} ms</td>
                      <td className="monitoring-cell-time">
                        {health?.lastCallAt
                          ? new Date(health.lastCallAt).toLocaleString('es-MX', {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            })
                          : '—'}
                      </td>
                      <td className="monitoring-cell-error-msg">
                        {health?.lastError ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Usage chart */}
      {usage.length > 0 && (
        <div className="monitoring-section">
          <h4 className="monitoring-section-title">
            <TrendingUp size={14} /> Consumo por extensión (diario)
          </h4>
          <div className="monitoring-usage-grid">
            {usage.map((u, i) => {
              const ext = extensions.find((e) => e.id === u.key);
              const maxCount = Math.max(...usage.map((x) => x.count), 1);
              const pct = (u.count / maxCount) * 100;
              return (
                <div key={i} className="monitoring-usage-bar">
                  <div className="monitoring-usage-bar-header">
                    <span className="monitoring-usage-bar-name">{ext?.name ?? u.key}</span>
                    <span className="monitoring-usage-bar-count">{u.count}</span>
                  </div>
                  <div className="monitoring-usage-bar-track">
                    <div
                      className="monitoring-usage-bar-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="monitoring-usage-bar-meta">
                    {u.period} · {u.unit}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent errors */}
      <div className="monitoring-section">
        <h4 className="monitoring-section-title">
          <AlertTriangle size={14} /> Errores recientes
        </h4>
        {recentErrors.length === 0 ? (
          <p className="assistant-admin-muted">Sin errores recientes.</p>
        ) : (
          <div className="monitoring-table-wrap">
            <table className="monitoring-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Herramienta</th>
                  <th>Estado</th>
                  <th>Latencia</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {recentErrors.map((e) => (
                  <tr key={e.id}>
                    <td className="monitoring-cell-time">
                      {new Date(e.createdAt).toLocaleString('es-MX', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td>{e.toolName}</td>
                    <td>
                      <span className="assistant-admin-badge assistant-admin-badge-error">
                        {e.status}
                      </span>
                    </td>
                    <td>{e.durationMs} ms</td>
                    <td className="monitoring-cell-error-msg">
                      {e.errorMessage ?? e.errorCode ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

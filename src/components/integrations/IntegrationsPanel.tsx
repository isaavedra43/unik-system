'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  XCircle,
  Zap,
} from 'lucide-react';
import { Alert, Badge, Button, FormField, Input, Select } from '@/components/ui/primitives';
import { Drawer, EmptyState, Modal, Toast } from '@/components/ui/composite';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ConfigRow {
  id: string;
  source: string;
  displayName: string;
  isEnabled: boolean;
  settings: Record<string, unknown>;
  updatedAt: string;
}

interface ApiCallRow {
  id: string;
  source: string;
  method: string;
  path: string;
  httpStatus: number | null;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
  responsePreview: string | null;
  createdAt: string;
}

interface StatsPayload {
  stats: {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    avgDurationMs: number;
    last24hCount: number;
    last24hErrorCount: number;
  };
  active_run: {
    runId: string;
    mode: string;
    status: string;
    startedAt: string;
  } | null;
  latest_run: {
    runId: string;
    mode: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    pagesScanned: number;
    recordsSeen: number;
    recordsPending: number;
    detailsFetched: number;
    detailsFailed: number;
    apiCalls: number;
    errorCode: string | null;
  } | null;
}

type TabId = 'overview' | 'calls' | 'config';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 60_000) return 'hace un momento';
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return `hace ${Math.floor(diff / 86_400_000)} d`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

/* ------------------------------------------------------------------ */
/* Setting field definitions                                           */
/* ------------------------------------------------------------------ */

interface SettingField {
  key: string;
  label: string;
  help: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

const SETTING_FIELDS: SettingField[] = [
  { key: 'syncIntervalMs', label: 'Intervalo entre syncs', help: 'Tiempo mínimo entre syncs automáticos', unit: 'ms', min: 60_000, max: 86_400_000, step: 60_000 },
  { key: 'checkIntervalMs', label: 'Intervalo de check', help: 'Cada cuánto revisar la DB (no consume API)', unit: 'ms', min: 10_000, max: 3_600_000, step: 10_000 },
  { key: 'startupDelayMs', label: 'Delay de inicio', help: 'Gracia antes del primer check tras boot', unit: 'ms', min: 0, max: 300_000, step: 1000 },
  { key: 'schedulerMaxDetailFetches', label: 'Detalles por sync (scheduler)', help: 'Máximo de detalles a descargar por sync programado', unit: '', min: 1, max: 200, step: 1 },
  { key: 'failedRetryCooldownMs', label: 'Cooldown tras fallo', help: 'Tiempo de espera antes de reintentar tras un fallo', unit: 'ms', min: 0, max: 3_600_000, step: 60_000 },
  { key: 'quickScanPages', label: 'Páginas quick scan', help: 'Páginas recientes a escanear en quick sync', unit: '', min: 1, max: 20, step: 1 },
  { key: 'quickMaxDetailFetches', label: 'Detalles quick sync', help: 'Máximo de detalles en sync manual', unit: '', min: 1, max: 200, step: 1 },
  { key: 'fullMaxDetailFetches', label: 'Detalles full sync', help: 'Máximo de detalles en sync completo', unit: '', min: 1, max: 200, step: 1 },
  { key: 'recentThresholdMs', label: 'Umbral "reciente"', help: 'Ventana para considerar un registro como reciente', unit: 'ms', min: 3_600_000, max: 7 * 86_400_000, step: 3_600_000 },
  { key: 'perPage', label: 'Registros por página', help: 'Tamaño de página al listar de Zoho', unit: '', min: 10, max: 200, step: 10 },
  { key: 'maxPages', label: 'Máximo de páginas', help: 'Límite defensivo anti-loop', unit: '', min: 1, max: 1000, step: 1 },
  { key: 'zohoRequestTimeoutMs', label: 'Timeout Zoho', help: 'Timeout por llamada HTTP a Zoho', unit: 'ms', min: 5_000, max: 120_000, step: 1000 },
  { key: 'prismaTimeoutMs', label: 'Timeout Prisma', help: 'Timeout por operación de DB', unit: 'ms', min: 5_000, max: 60_000, step: 1000 },
  { key: 'quickSyncTimeoutMs', label: 'Timeout total quick', help: 'Wall-clock máximo para quick sync', unit: 'ms', min: 30_000, max: 600_000, step: 30_000 },
  { key: 'scanSyncTimeoutMs', label: 'Timeout total scan', help: 'Wall-clock máximo para scan', unit: 'ms', min: 60_000, max: 1_800_000, step: 60_000 },
  { key: 'fullSyncTimeoutMs', label: 'Timeout total full', help: 'Wall-clock máximo para full sync', unit: 'ms', min: 60_000, max: 3_600_000, step: 60_000 },
  { key: 'staleRunThresholdMs', label: 'Umbral stale run', help: 'RUNNING más antiguo que esto se marca FAILED', unit: 'ms', min: 60_000, max: 3_600_000, step: 60_000 },
];

const DEFAULT_VALUES: Record<string, number> = {
  syncIntervalMs: 3_600_000,
  checkIntervalMs: 300_000,
  startupDelayMs: 30_000,
  schedulerMaxDetailFetches: 100,
  failedRetryCooldownMs: 1_800_000,
  quickScanPages: 2,
  quickMaxDetailFetches: 20,
  fullMaxDetailFetches: 50,
  recentThresholdMs: 86_400_000,
  perPage: 200,
  maxPages: 200,
  zohoRequestTimeoutMs: 30_000,
  prismaTimeoutMs: 15_000,
  quickSyncTimeoutMs: 180_000,
  scanSyncTimeoutMs: 300_000,
  fullSyncTimeoutMs: 900_000,
  staleRunThresholdMs: 600_000,
};

/* ------------------------------------------------------------------ */
/* Main panel                                                          */
/* ------------------------------------------------------------------ */

export function IntegrationsPanel({ canManage }: { canManage: boolean }) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [configs, setConfigs] = useState<ConfigRow[]>([]);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [calls, setCalls] = useState<ApiCallRow[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [configsError, setConfigsError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ visible: boolean; message: string; variant: 'success' | 'error' | 'info' }>({
    visible: false,
    message: '',
    variant: 'info',
  });
  const [selectedSource, setSelectedSource] = useState<string>('zoho');
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ConfigRow | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<ApiCallRow | null>(null);

  const showToast = useCallback(
    (message: string, variant: 'success' | 'error' | 'info' = 'info') => {
      setToast({ visible: true, message, variant });
    },
    []
  );

  /* ---- Loaders ---- */

  const loadConfigs = useCallback(async () => {
    setLoadingConfigs(true);
    setConfigsError(null);
    try {
      const res = await fetch('/app/admin/integrations/api/configs');
      if (res.ok) {
        const json = await res.json();
        setConfigs(json.data);
      } else if (res.status === 403) {
        setConfigsError('Sin permiso para ver configuraciones.');
      } else {
        setConfigsError('Error al cargar configuraciones.');
      }
    } catch {
      setConfigsError('Error de red al cargar configuraciones.');
    } finally {
      setLoadingConfigs(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    setLoadingStats(true);
    setStatsError(null);
    try {
      const res = await fetch(`/app/admin/integrations/api/stats?source=${selectedSource}`);
      if (res.ok) {
        setStats(await res.json());
      } else if (res.status === 403) {
        setStatsError('Sin permiso para ver estadísticas.');
      } else {
        setStatsError('Error al cargar estadísticas.');
      }
    } catch {
      setStatsError('Error de red al cargar estadísticas.');
    } finally {
      setLoadingStats(false);
    }
  }, [selectedSource]);

  const loadCalls = useCallback(async () => {
    setLoadingCalls(true);
    setCallsError(null);
    try {
      const params = new URLSearchParams({
        source: selectedSource,
        limit: '100',
        onlyErrors: onlyErrors ? 'true' : 'false',
      });
      const res = await fetch(`/app/admin/integrations/api/calls?${params}`);
      if (res.ok) {
        const json = await res.json();
        setCalls(json.data);
      } else if (res.status === 403) {
        setCallsError('Sin permiso para ver llamadas.');
      } else {
        setCallsError('Error al cargar llamadas.');
      }
    } catch {
      setCallsError('Error de red al cargar llamadas.');
    } finally {
      setLoadingCalls(false);
    }
  }, [selectedSource, onlyErrors]);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    if (activeTab === 'calls') void loadCalls();
  }, [activeTab, loadCalls]);

  // Poll stats every 10s on overview tab
  useEffect(() => {
    if (activeTab !== 'overview') return;
    const interval = setInterval(() => void loadStats(), 10_000);
    return () => clearInterval(interval);
  }, [activeTab, loadStats]);

  // Poll calls every 5s on calls tab
  useEffect(() => {
    if (activeTab !== 'calls') return;
    const interval = setInterval(() => void loadCalls(), 5_000);
    return () => clearInterval(interval);
  }, [activeTab, loadCalls]);

  /* ---- Actions ---- */

  const handleToggleEnabled = useCallback(
    async (config: ConfigRow) => {
      if (!canManage) return;
      try {
        const res = await fetch('/app/admin/integrations/api/configs', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: config.source,
            isEnabled: !config.isEnabled,
          }),
        });
        if (res.ok) {
          showToast(
            `${config.displayName} ${config.isEnabled ? 'desactivada' : 'activada'}`,
            'success'
          );
          void loadConfigs();
        } else {
          const json = await res.json().catch(() => ({}));
          showToast(json.error ?? 'Error al cambiar estado', 'error');
        }
      } catch {
        showToast('Error de red', 'error');
      }
    },
    [canManage, loadConfigs, showToast]
  );

  const handleSaveConfig = useCallback(
    async (settings: Record<string, unknown>) => {
      if (!editingConfig) return;
      setSavingConfig(true);
      setConfigError(null);
      try {
        const res = await fetch('/app/admin/integrations/api/configs', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: editingConfig.source,
            settings,
          }),
        });
        if (res.ok) {
          showToast('Configuración guardada', 'success');
          setConfigDrawerOpen(false);
          setEditingConfig(null);
          void loadConfigs();
        } else {
          const json = await res.json().catch(() => ({}));
          setConfigError(json.error ?? 'Error al guardar');
        }
      } catch {
        setConfigError('Error de red');
      } finally {
        setSavingConfig(false);
      }
    },
    [editingConfig, loadConfigs, showToast]
  );

  const handleTriggerSync = useCallback(
    async (mode: 'quick' | 'scan' | 'sync') => {
      if (!canManage) return;
      setTriggering(true);
      setTriggerError(null);
      try {
        const res = await fetch('/app/admin/integrations/api/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          showToast(
            `Sync ${mode} completado: ${json.result?.detailsFetched ?? 0} detalles, ${json.result?.apiCalls ?? 0} llamadas`,
            'success'
          );
          void loadStats();
          if (activeTab === 'calls') void loadCalls();
        } else if (res.status === 409) {
          showToast('Ya hay un sync en curso', 'info');
        } else {
          setTriggerError(json.error ?? 'Error al ejecutar sync');
        }
      } catch {
        setTriggerError('Error de red');
      } finally {
        setTriggering(false);
      }
    },
    [canManage, loadStats, loadCalls, activeTab, showToast]
  );

  /* ---- Derived ---- */

  const tabs = useMemo(
    () => [
      { id: 'overview' as TabId, label: 'Resumen' },
      { id: 'calls' as TabId, label: 'Llamadas' },
      { id: 'config' as TabId, label: 'Configuración' },
    ],
    []
  );

  return (
    <div className="integrations-panel">
      <Toast
        visible={toast.visible}
        message={toast.message}
        variant={toast.variant}
        onClose={() => setToast((t) => ({ ...t, visible: false }))}
      />

      {/* Source selector */}
      <div className="integrations-source-bar">
        <FormField label="API" htmlFor="source-select">
          <Select
            id="source-select"
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
          >
            {configs.length === 0 ? (
              <option value="zoho">Zoho Inventory</option>
            ) : (
              configs.map((c) => (
                <option key={c.source} value={c.source}>
                  {c.displayName}
                </option>
              ))
            )}
          </Select>
        </FormField>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={16} />}
          onClick={() => {
            void loadStats();
            if (activeTab === 'calls') void loadCalls();
            if (activeTab === 'config') void loadConfigs();
          }}
          aria-label="Refrescar"
        >
          Refrescar
        </Button>
      </div>

      {/* Tabs */}
      <div className="tabs" role="tablist" aria-label="Secciones de integración">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            className={`tab ${tab.id === activeTab ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {activeTab === 'overview' ? (
        <OverviewTab
          stats={stats}
          loading={loadingStats}
          error={statsError}
          canManage={canManage}
          triggering={triggering}
          triggerError={triggerError}
          onTrigger={handleTriggerSync}
        />
      ) : null}

      {/* Calls tab */}
      {activeTab === 'calls' ? (
        <CallsTab
          calls={calls}
          loading={loadingCalls}
          error={callsError}
          onlyErrors={onlyErrors}
          onToggleOnlyErrors={() => setOnlyErrors((v) => !v)}
          onSelectCall={setSelectedCall}
        />
      ) : null}

      {/* Config tab */}
      {activeTab === 'config' ? (
        <ConfigTab
          configs={configs}
          loading={loadingConfigs}
          error={configsError}
          canManage={canManage}
          onToggleEnabled={handleToggleEnabled}
          onEdit={(c) => {
            setEditingConfig(c);
            setConfigDrawerOpen(true);
          }}
        />
      ) : null}

      {/* Config drawer */}
      <ConfigDrawer
        open={configDrawerOpen}
        config={editingConfig}
        saving={savingConfig}
        error={configError}
        onClose={() => {
          setConfigDrawerOpen(false);
          setEditingConfig(null);
          setConfigError(null);
        }}
        onSave={handleSaveConfig}
      />

      {/* Call detail modal */}
      <Modal
        open={selectedCall !== null}
        onClose={() => setSelectedCall(null)}
        title="Detalle de llamada"
      >
        {selectedCall ? <CallDetailContent call={selectedCall} /> : null}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview tab                                                        */
/* ------------------------------------------------------------------ */

function OverviewTab({
  stats,
  loading,
  error,
  canManage,
  triggering,
  triggerError,
  onTrigger,
}: {
  stats: StatsPayload | null;
  loading: boolean;
  error: string | null;
  canManage: boolean;
  triggering: boolean;
  triggerError: string | null;
  onTrigger: (mode: 'quick' | 'scan' | 'sync') => void;
}) {
  if (loading && !stats) {
    return (
      <div className="integrations-loading">
        <Loader2 className="spin" size={24} />
        <span>Cargando estadísticas…</span>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="integrations-error-state">
        <Alert variant="error">{error}</Alert>
      </div>
    );
  }

  if (!stats) {
    return (
      <EmptyState
        icon="settings"
        title="Sin datos aún"
        message="Aún no hay llamadas registradas para esta integración."
      />
    );
  }

  const { stats: s, active_run: activeRun, latest_run: latestRun } = stats;
  const successRate =
    s.totalCalls > 0 ? ((s.successCount / s.totalCalls) * 100).toFixed(1) : '—';

  return (
    <div className="integrations-overview">
      {error ? <Alert variant="warning">{error}</Alert> : null}

      {/* Stat cards */}
      <div className="integrations-stat-grid">
        <StatCard
          icon={<Activity size={20} />}
          label="Total llamadas"
          value={s.totalCalls.toLocaleString('es-MX')}
          sub={`${s.last24hCount.toLocaleString('es-MX')} en 24h`}
        />
        <StatCard
          icon={<CheckCircle2 size={20} />}
          label="Tasa de éxito"
          value={`${successRate}%`}
          sub={`${s.successCount.toLocaleString('es-MX')} ok`}
          tone="success"
        />
        <StatCard
          icon={<XCircle size={20} />}
          label="Errores"
          value={s.errorCount.toLocaleString('es-MX')}
          sub={`${s.last24hErrorCount.toLocaleString('es-MX')} en 24h`}
          tone={s.errorCount > 0 ? 'danger' : undefined}
        />
        <StatCard
          icon={<Clock size={20} />}
          label="Duración prom."
          value={formatDuration(s.avgDurationMs)}
          sub="por llamada"
        />
      </div>

      {/* Active + latest run */}
      <div className="integrations-run-grid">
        <div className="card card-compact">
          <div className="card-header">
            <h3 className="card-title">Sync activo</h3>
          </div>
          {activeRun ? (
            <div className="integrations-run-info">
              <div className="integrations-run-row">
                <Badge variant="warning">RUNNING</Badge>
                <span className="integrations-run-mode">{activeRun.mode}</span>
              </div>
              <p className="integrations-run-time">
                Iniciado {formatRelative(activeRun.startedAt)}
              </p>
            </div>
          ) : (
            <p className="integrations-run-empty">No hay sync en curso.</p>
          )}
        </div>

        <div className="card card-compact">
          <div className="card-header">
            <h3 className="card-title">Último sync</h3>
          </div>
          {latestRun ? (
            <div className="integrations-run-info">
              <div className="integrations-run-row">
                <Badge variant={latestRun.status === 'COMPLETED' ? 'success' : 'danger'}>
                  {latestRun.status}
                </Badge>
                <span className="integrations-run-mode">{latestRun.mode}</span>
              </div>
              <div className="integrations-run-metrics">
                <span>{latestRun.pagesScanned} páginas</span>
                <span>{latestRun.detailsFetched} detalles</span>
                <span>{latestRun.apiCalls} llamadas</span>
              </div>
              <p className="integrations-run-time">
                {latestRun.completedAt
                  ? `Completado ${formatRelative(latestRun.completedAt)}`
                  : `Iniciado ${formatRelative(latestRun.startedAt)}`}
              </p>
              {latestRun.errorCode ? (
                <p className="integrations-run-error">Error: {latestRun.errorCode}</p>
              ) : null}
            </div>
          ) : (
            <p className="integrations-run-empty">Sin syncs previos.</p>
          )}
        </div>
      </div>

      {/* Trigger controls */}
      {canManage ? (
        <div className="card card-compact integrations-trigger-card">
          <div className="card-header">
            <h3 className="card-title">Ejecutar sincronización</h3>
          </div>
          {triggerError ? <Alert variant="error">{triggerError}</Alert> : null}
          <div className="integrations-trigger-row">
            <Button
              variant="primary"
              size="sm"
              icon={<Zap size={16} />}
              isLoading={triggering}
              onClick={() => onTrigger('quick')}
              disabled={triggering}
            >
              Quick sync
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={16} />}
              isLoading={triggering}
              onClick={() => onTrigger('scan')}
              disabled={triggering}
            >
              Scan
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Activity size={16} />}
              isLoading={triggering}
              onClick={() => onTrigger('sync')}
              disabled={triggering}
            >
              Full sync
            </Button>
          </div>
          <p className="form-help">
            Quick: páginas recientes + detalles. Scan: todas las páginas. Full: scan + detalles
            completos.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: 'success' | 'danger';
}) {
  const cls = `integrations-stat-card ${tone ? `integrations-stat-${tone}` : ''}`;
  return (
    <div className={cls}>
      <div className="integrations-stat-icon">{icon}</div>
      <div className="integrations-stat-body">
        <div className="integrations-stat-value">{value}</div>
        <div className="integrations-stat-label">{label}</div>
        {sub ? <div className="integrations-stat-sub">{sub}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Calls tab                                                           */
/* ------------------------------------------------------------------ */

function CallsTab({
  calls,
  loading,
  error,
  onlyErrors,
  onToggleOnlyErrors,
  onSelectCall,
}: {
  calls: ApiCallRow[];
  loading: boolean;
  error: string | null;
  onlyErrors: boolean;
  onToggleOnlyErrors: () => void;
  onSelectCall: (call: ApiCallRow) => void;
}) {
  return (
    <div className="integrations-calls">
      <div className="integrations-calls-toolbar">
        <label className="integrations-checkbox">
          <input type="checkbox" checked={onlyErrors} onChange={onToggleOnlyErrors} />
          Solo errores
        </label>
        {loading ? (
          <span className="integrations-loading-inline">
            <Loader2 className="spin" size={14} /> Actualizando…
          </span>
        ) : null}
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {!error && calls.length === 0 ? (
        <EmptyState
          icon="check"
          title="Sin llamadas"
          message={
            onlyErrors ? 'No hay llamadas con error.' : 'Aún no se han registrado llamadas.'
          }
        />
      ) : null}

      {!error && calls.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>Método</th>
                <th>Path</th>
                <th>HTTP</th>
                <th>Duración</th>
                <th>Estado</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr
                  key={call.id}
                  className="integrations-call-row"
                  onClick={() => onSelectCall(call)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="integrations-call-time">{formatDateTime(call.createdAt)}</td>
                  <td>
                    <span
                      className={`integrations-method integrations-method-${call.method.toLowerCase()}`}
                    >
                      {call.method}
                    </span>
                  </td>
                  <td className="integrations-call-path">{call.path}</td>
                  <td>{call.httpStatus ?? '—'}</td>
                  <td>{formatDuration(call.durationMs)}</td>
                  <td>
                    {call.success ? (
                      <span className="integrations-call-ok">
                        <CheckCircle2 size={14} /> OK
                      </span>
                    ) : (
                      <span className="integrations-call-err">
                        <XCircle size={14} /> Error
                      </span>
                    )}
                  </td>
                  <td className="integrations-call-errorcode">{call.errorCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Config tab                                                          */
/* ------------------------------------------------------------------ */

function ConfigTab({
  configs,
  loading,
  error,
  canManage,
  onToggleEnabled,
  onEdit,
}: {
  configs: ConfigRow[];
  loading: boolean;
  error: string | null;
  canManage: boolean;
  onToggleEnabled: (config: ConfigRow) => void;
  onEdit: (config: ConfigRow) => void;
}) {
  if (loading && configs.length === 0) {
    return (
      <div className="integrations-loading">
        <Loader2 className="spin" size={24} />
        <span>Cargando configuraciones…</span>
      </div>
    );
  }

  if (error && configs.length === 0) {
    return (
      <div className="integrations-error-state">
        <Alert variant="error">{error}</Alert>
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <EmptyState
        icon="settings"
        title="Sin integraciones"
        message="No hay integraciones configuradas todavía."
      />
    );
  }

  return (
    <div className="integrations-config-list">
      {error ? <Alert variant="warning">{error}</Alert> : null}
      {configs.map((config) => (
        <div key={config.id} className="card card-compact integrations-config-card">
          <div className="integrations-config-header">
            <div className="integrations-config-info">
              <h3 className="card-title">{config.displayName}</h3>
              <p className="integrations-config-source">{config.source}</p>
            </div>
            <div className="integrations-config-actions">
              <Badge variant={config.isEnabled ? 'success' : 'weak'}>
                {config.isEnabled ? 'Activa' : 'Inactiva'}
              </Badge>
              {canManage ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={
                      config.isEnabled ? <PauseCircle size={16} /> : <PlayCircle size={16} />
                    }
                    onClick={() => onToggleEnabled(config)}
                  >
                    {config.isEnabled ? 'Pausar' : 'Activar'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<SettingsIcon size={16} />}
                    onClick={() => onEdit(config)}
                  >
                    Configurar
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          <div className="integrations-config-summary">
            <span>
              <strong>Sync interval:</strong>{' '}
              {formatDuration(config.settings.syncIntervalMs as number)}
            </span>
            <span>
              <strong>Check interval:</strong>{' '}
              {formatDuration(config.settings.checkIntervalMs as number)}
            </span>
            <span>
              <strong>Quick pages:</strong> {config.settings.quickScanPages as number}
            </span>
            <span>
              <strong>Max details:</strong>{' '}
              {config.settings.schedulerMaxDetailFetches as number}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Config drawer                                                       */
/* ------------------------------------------------------------------ */

function ConfigDrawer({
  open,
  config,
  saving,
  error,
  onClose,
  onSave,
}: {
  open: boolean;
  config: ConfigRow | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (settings: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (config) {
      const values: Record<string, string> = {};
      for (const field of SETTING_FIELDS) {
        const v = config.settings[field.key];
        values[field.key] = typeof v === 'number' ? String(v) : String(DEFAULT_VALUES[field.key] ?? 0);
      }
      setDraft(values);
    }
  }, [config]);

  const handleReset = () => {
    const values: Record<string, string> = {};
    for (const field of SETTING_FIELDS) {
      values[field.key] = String(DEFAULT_VALUES[field.key] ?? 0);
    }
    setDraft(values);
  };

  const handleSave = () => {
    const numeric: Record<string, number> = {};
    for (const field of SETTING_FIELDS) {
      const raw = draft[field.key];
      const parsed = parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        numeric[field.key] = DEFAULT_VALUES[field.key] ?? 0;
      } else {
        numeric[field.key] = Math.max(field.min, Math.min(field.max, parsed));
      }
    }
    onSave(numeric);
  };

  if (!config) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Configurar ${config.displayName}`}
      subtitle="Los cambios aplican inmediatamente. El scheduler los lee en el próximo tick."
      size="lg"
      footer={
        <>
          <Button
            variant="ghost"
            icon={<RotateCcw size={16} />}
            onClick={handleReset}
            disabled={saving}
          >
            Reset
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button
            type="button"
            isLoading={saving}
            onClick={handleSave}
            disabled={saving}
          >
            Guardar
          </Button>
        </>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className="integrations-config-form">
        {SETTING_FIELDS.map((field) => (
          <FormField
            key={field.key}
            label={`${field.label}${field.unit ? ` (${field.unit})` : ''}`}
            htmlFor={`cfg-${field.key}`}
            help={field.help}
          >
            <Input
              id={`cfg-${field.key}`}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={draft[field.key] ?? ''}
              onChange={(e) => {
                setDraft((d) => ({ ...d, [field.key]: e.target.value }));
              }}
            />
          </FormField>
        ))}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* Call detail modal content                                           */
/* ------------------------------------------------------------------ */

function CallDetailContent({ call }: { call: ApiCallRow }) {
  return (
    <div className="integrations-call-detail">
      <div className="integrations-call-detail-row">
        <span className="integrations-call-detail-label">Hora</span>
        <span>{formatDateTime(call.createdAt)}</span>
      </div>
      <div className="integrations-call-detail-row">
        <span className="integrations-call-detail-label">Método</span>
        <span>
          <span
            className={`integrations-method integrations-method-${call.method.toLowerCase()}`}
          >
            {call.method}
          </span>
        </span>
      </div>
      <div className="integrations-call-detail-row">
        <span className="integrations-call-detail-label">Path</span>
        <span className="integrations-call-detail-path">{call.path}</span>
      </div>
      <div className="integrations-call-detail-row">
        <span className="integrations-call-detail-label">HTTP Status</span>
        <span>{call.httpStatus ?? '—'}</span>
      </div>
      <div className="integrations-call-detail-row">
        <span className="integrations-call-detail-label">Duración</span>
        <span>{formatDuration(call.durationMs)}</span>
      </div>
      <div className="integrations-call-detail-row">
        <span className="integrations-call-detail-label">Estado</span>
        <span>
          {call.success ? (
            <Badge variant="success">OK</Badge>
          ) : (
            <Badge variant="danger">Error</Badge>
          )}
        </span>
      </div>
      {call.errorCode ? (
        <div className="integrations-call-detail-row">
          <span className="integrations-call-detail-label">Código de error</span>
          <span className="integrations-call-errorcode">{call.errorCode}</span>
        </div>
      ) : null}
      {call.responsePreview ? (
        <div className="integrations-call-detail-preview">
          <span className="integrations-call-detail-label">Respuesta (preview)</span>
          <pre className="integrations-call-pre">{call.responsePreview}</pre>
        </div>
      ) : null}
    </div>
  );
}

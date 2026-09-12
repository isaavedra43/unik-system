'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  Database,
  HardDrive,
  RefreshCw,
  Save,
  ShieldCheck,
  Upload,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { AssistantAdminStatCard } from '@/components/assistant/admin/AssistantAdminStatCard';

/**
 * Storage administration panel. Reuses the assistant-admin design classes so
 * every admin surface looks the same. All actions run as durable background
 * jobs; the panel only enqueues and observes them.
 */

interface Overview {
  driver: 'r2' | 'disk';
  backupConfigured: boolean;
  buckets: Array<{ alias: string; configured: boolean }>;
  totals: {
    objects: number;
    readyBytes: string;
    byStatus: Record<string, number>;
    byPurpose: Record<string, { count: number; bytes: string }>;
    pendingUploads: number;
    legacyReferences: { aiAttachments: number; chatAttachments: number; aiArtifacts: number };
  };
  jobs: Record<string, number>;
  migration: { mode: string; updatedAt: string; totals: Record<string, number> } | null;
  backup: {
    lastRunAt: string | null;
    lastManifestKey: string | null;
    objectsBackedUp: number;
  } | null;
  reconcile: Record<string, unknown> | null;
  settings: Record<string, number | boolean>;
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  result: unknown;
}

type TabId = 'overview' | 'migration' | 'backup' | 'jobs' | 'settings';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Resumen' },
  { id: 'migration', label: 'Migración' },
  { id: 'backup', label: 'Respaldo' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'settings', label: 'Cuotas y retención' },
];

const MIGRATION_STEPS: Array<{ mode: string; label: string; hint: string }> = [
  {
    mode: 'inventory',
    label: '1. Inventario',
    hint: 'Lee las referencias de la base y detecta archivos presentes, ausentes y compartidos.',
  },
  { mode: 'dry-run', label: '2. Dry-run', hint: 'Calcula checksums. No escribe nada en R2.' },
  {
    mode: 'copy',
    label: '3. Copiar',
    hint: 'Sube por lotes a R2 y crea los StorageObject. No borra originales.',
  },
  {
    mode: 'verify',
    label: '4. Verificar',
    hint: 'Re-lee cada copia, compara checksum y vincula los registros originales.',
  },
  {
    mode: 'reconcile',
    label: '5. Reconciliar',
    hint: 'Compara base y almacenamiento en ambos sentidos. Solo reporta.',
  },
];

const SETTING_FIELDS: Array<{
  key: string;
  label: string;
  type: 'number' | 'boolean';
  hint?: string;
}> = [
  {
    key: 'perUserDailyQuotaBytes',
    label: 'Cuota diaria por usuario (bytes)',
    type: 'number',
    hint: '0 = sin límite',
  },
  {
    key: 'environmentDailyQuotaBytes',
    label: 'Cuota diaria del entorno (bytes)',
    type: 'number',
    hint: '0 = sin límite',
  },
  {
    key: 'partSizeBytes',
    label: 'Tamaño de parte multipart (bytes)',
    type: 'number',
    hint: 'Mínimo 5 MiB',
  },
  { key: 'multipartThresholdBytes', label: 'Umbral multipart (bytes)', type: 'number' },
  {
    key: 'uploadSessionTtlHours',
    label: 'Caducidad de cargas incompletas (horas)',
    type: 'number',
  },
  { key: 'uploadUrlTtlSeconds', label: 'Vigencia de URL de subida (s)', type: 'number' },
  { key: 'signedUrlTtlSeconds', label: 'Vigencia de URL firmada de descarga (s)', type: 'number' },
  { key: 'maxZipExpansionBytes', label: 'Expansión máxima de ZIP (bytes)', type: 'number' },
  { key: 'maxZipRatio', label: 'Ratio máximo de compresión', type: 'number' },
  { key: 'maxZipEntries', label: 'Entradas máximas por ZIP', type: 'number' },
  {
    key: 'inlineValidationWaitMs',
    label: 'Espera de validación al completar (ms)',
    type: 'number',
  },
  { key: 'recordingRetentionDays', label: 'Retención de grabaciones (días)', type: 'number' },
  { key: 'transcriptRetentionDays', label: 'Retención de transcripciones (días)', type: 'number' },
  { key: 'cleanupEnabled', label: 'Limpieza automática', type: 'boolean' },
  { key: 'backupEnabled', label: 'Respaldo diario automático', type: 'boolean' },
  { key: 'preferSignedUrls', label: 'Preferir URLs firmadas para descargas', type: 'boolean' },
];

function formatBytes(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function statusBadge(status: string): string {
  if (status === 'completed' || status === 'ready')
    return 'assistant-admin-badge assistant-admin-badge-success';
  if (status === 'failed' || status === 'rejected' || status === 'missing')
    return 'assistant-admin-badge assistant-admin-badge-error';
  return 'assistant-admin-badge';
}

export function FilesAdminPanel() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, number | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [restoreId, setRestoreId] = useState('');

  const load = useCallback(async () => {
    try {
      const [ov, jb] = await Promise.all([
        fetch('/app/admin/files/api/overview'),
        fetch('/app/admin/files/api/jobs'),
      ]);
      if (ov.ok) {
        const data = (await ov.json()) as Overview;
        setOverview(data);
        setSettings((prev) => (Object.keys(prev).length === 0 ? data.settings : prev));
      } else {
        setError('No se pudo cargar el estado del almacenamiento');
      }
      if (jb.ok) setJobs(((await jb.json()) as { jobs: JobRow[] }).jobs);
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [load]);

  async function post(url: string, body?: unknown, okMessage?: string) {
    setError(null);
    setNotice(null);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(
        (data as { error?: string; reason?: string }).error ??
          (data as { reason?: string }).reason ??
          'Error'
      );
      return null;
    }
    setNotice(okMessage ?? 'Solicitud encolada');
    await load();
    return data;
  }

  async function saveSettings() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/app/admin/files/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? 'No se pudo guardar');
      } else {
        setNotice('Configuración guardada');
        await load();
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading && !overview) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!overview) return <div className="assistant-admin-error">{error ?? 'Sin datos'}</div>;

  const t = overview.totals;
  const legacyTotal =
    t.legacyReferences.aiAttachments +
    t.legacyReferences.chatAttachments +
    t.legacyReferences.aiArtifacts;

  return (
    <div className="assistant-admin-panel">
      <div className="assistant-admin-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`assistant-admin-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {notice && (
        <div className="assistant-admin-success" role="status">
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}

      <div className="assistant-admin-tab-content">
        {activeTab === 'overview' && (
          <div className="assistant-admin-overview">
            <div className="assistant-admin-stat-grid">
              <AssistantAdminStatCard
                label="Proveedor"
                value={overview.driver === 'r2' ? 'Cloudflare R2' : 'Disco local'}
                hint={
                  overview.driver === 'disk'
                    ? 'Solo desarrollo: los archivos no sobreviven un redeploy'
                    : 'Buckets privados, región auto'
                }
                icon={<HardDrive size={20} />}
                tone={overview.driver === 'disk' ? 'warning' : 'success'}
              />
              <AssistantAdminStatCard
                label="Objetos"
                value={t.objects.toLocaleString('es-MX')}
                hint={`${t.byStatus.ready ?? 0} listos`}
                icon={<Database size={20} />}
              />
              <AssistantAdminStatCard
                label="Almacenado (listos)"
                value={formatBytes(t.readyBytes)}
                icon={<Archive size={20} />}
              />
              <AssistantAdminStatCard
                label="Cargas en curso"
                value={t.pendingUploads}
                hint="Se abortan a las 24 h"
                icon={<Upload size={20} />}
              />
              <AssistantAdminStatCard
                label="Archivos heredados sin migrar"
                value={legacyTotal.toLocaleString('es-MX')}
                hint={`IA ${t.legacyReferences.aiAttachments} · Chat ${t.legacyReferences.chatAttachments} · Artefactos ${t.legacyReferences.aiArtifacts}`}
                icon={<RefreshCw size={20} />}
                tone={legacyTotal > 0 ? 'warning' : 'success'}
              />
              <AssistantAdminStatCard
                label="Respaldo"
                value={
                  overview.backup?.lastRunAt
                    ? new Date(overview.backup.lastRunAt).toLocaleString('es-MX')
                    : 'Nunca'
                }
                hint={
                  overview.backupConfigured
                    ? `${overview.backup?.objectsBackedUp ?? 0} objetos respaldados`
                    : 'R2_BACKUP_* no configurado'
                }
                icon={<ShieldCheck size={20} />}
                tone={overview.backupConfigured ? 'default' : 'warning'}
              />
            </div>

            <div className="assistant-admin-section">
              <h3 className="assistant-admin-section-title">Por estado</h3>
              <div className="assistant-admin-list">
                {Object.entries(t.byStatus).map(([status, count]) => (
                  <div key={status} className="assistant-admin-list-item">
                    <span className={statusBadge(status)}>{status}</span>
                    <span className="assistant-admin-list-count">{count}</span>
                  </div>
                ))}
                {Object.keys(t.byStatus).length === 0 && (
                  <div className="assistant-admin-empty">Aún no hay objetos.</div>
                )}
              </div>
            </div>

            <div className="assistant-admin-section">
              <h3 className="assistant-admin-section-title">Por propósito (listos)</h3>
              <div className="assistant-admin-table-wrap">
                <table className="assistant-admin-table">
                  <thead>
                    <tr>
                      <th>Propósito</th>
                      <th>Objetos</th>
                      <th>Bytes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(t.byPurpose).map(([purpose, v]) => (
                      <tr key={purpose}>
                        <td>{purpose}</td>
                        <td>{v.count}</td>
                        <td>{formatBytes(v.bytes)}</td>
                      </tr>
                    ))}
                    {Object.keys(t.byPurpose).length === 0 && (
                      <tr>
                        <td colSpan={3} className="assistant-admin-muted">
                          Sin datos
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'migration' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Migración de archivos heredados a R2</h3>
            <p className="assistant-admin-muted">
              Cada paso es reanudable y ninguno borra los originales. La copia de datos reales y la
              limpieza definitiva son operaciones posteriores del administrador.
            </p>
            <div className="assistant-admin-list">
              {MIGRATION_STEPS.map((step) => (
                <div key={step.mode} className="assistant-admin-list-item">
                  <div>
                    <div className="assistant-admin-list-name">{step.label}</div>
                    <div className="assistant-admin-list-meta">{step.hint}</div>
                  </div>
                  <button
                    type="button"
                    className="assistant-admin-test-btn"
                    onClick={() =>
                      post(
                        '/app/admin/files/api/migration',
                        { mode: step.mode },
                        `Paso "${step.label}" encolado`
                      )
                    }
                  >
                    Ejecutar
                  </button>
                </div>
              ))}
            </div>
            {overview.migration && (
              <div className="assistant-admin-test-result">
                <div>
                  Último modo: <strong>{overview.migration.mode}</strong> · actualizado{' '}
                  {new Date(overview.migration.updatedAt).toLocaleString('es-MX')}
                </div>
                <div className="assistant-admin-stat-grid">
                  {Object.entries(overview.migration.totals).map(([k, v]) => (
                    <AssistantAdminStatCard
                      key={k}
                      label={k}
                      value={k === 'bytes' ? formatBytes(v) : v}
                    />
                  ))}
                </div>
              </div>
            )}
            {overview.reconcile && (
              <div className="assistant-admin-test-result">
                <div className="assistant-admin-list-name">Última reconciliación</div>
                <pre className="assistant-admin-msg-preview">
                  {JSON.stringify(overview.reconcile, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {activeTab === 'backup' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">
              Respaldo incremental (cuenta separada)
            </h3>
            <p className="assistant-admin-muted">
              Copia diaria de objetos nuevos o modificados con manifiesto (objetos, referencias,
              checksums). Respeta la fecha de vencimiento original: nunca extiende la retención de
              grabaciones o transcripciones.
            </p>
            <div className="assistant-admin-list">
              <div className="assistant-admin-list-item">
                <div>
                  <div className="assistant-admin-list-name">Ejecutar respaldo ahora</div>
                  <div className="assistant-admin-list-meta">
                    {overview.backupConfigured
                      ? 'Usa las credenciales R2_BACKUP_*'
                      : 'Configura R2_BACKUP_* para habilitarlo'}
                  </div>
                </div>
                <button
                  type="button"
                  className="assistant-admin-test-btn"
                  disabled={!overview.backupConfigured}
                  onClick={() =>
                    post('/app/admin/files/api/backup', undefined, 'Respaldo encolado')
                  }
                >
                  Respaldar
                </button>
              </div>
              <div className="assistant-admin-list-item">
                <div style={{ flex: 1 }}>
                  <div className="assistant-admin-list-name">
                    Restaurar un objeto (prueba de recuperación)
                  </div>
                  <div className="assistant-admin-list-meta">
                    Se verifica el checksum antes de marcarlo disponible.
                  </div>
                  <input
                    className="assistant-admin-filter-input"
                    placeholder="ID del StorageObject"
                    value={restoreId}
                    onChange={(e) => setRestoreId(e.target.value)}
                    aria-label="ID del objeto a restaurar"
                  />
                </div>
                <button
                  type="button"
                  className="assistant-admin-test-btn"
                  disabled={!restoreId}
                  onClick={() =>
                    post(
                      '/app/admin/files/api/backup/restore',
                      { objectId: restoreId },
                      'Objeto restaurado'
                    )
                  }
                >
                  Restaurar
                </button>
              </div>
            </div>
            {overview.backup && (
              <div className="assistant-admin-test-result">
                Último respaldo:{' '}
                {overview.backup.lastRunAt
                  ? new Date(overview.backup.lastRunAt).toLocaleString('es-MX')
                  : 'nunca'}{' '}
                · manifiesto: {overview.backup.lastManifestKey ?? '—'} · acumulado:{' '}
                {overview.backup.objectsBackedUp} objetos
              </div>
            )}
          </div>
        )}

        {activeTab === 'jobs' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Trabajos de segundo plano</h3>
            <div className="assistant-admin-stat-grid">
              {Object.entries(overview.jobs).map(([status, count]) => (
                <AssistantAdminStatCard key={status} label={status} value={count} />
              ))}
            </div>
            <div className="assistant-admin-table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Estado</th>
                    <th>Progreso</th>
                    <th>Intentos</th>
                    <th>Creado</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>{job.type}</td>
                      <td>
                        <span className={statusBadge(job.status)}>{job.status}</span>
                      </td>
                      <td>{job.progress}%</td>
                      <td>{job.attempts}</td>
                      <td>{new Date(job.createdAt).toLocaleString('es-MX')}</td>
                      <td className="assistant-admin-msg-preview">{job.lastError ?? ''}</td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="assistant-admin-muted">
                        Sin trabajos todavía
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Cuotas, multipart y retención</h3>
            <div className="assistant-admin-config-grid">
              {SETTING_FIELDS.map((field) => (
                <div key={field.key} className="assistant-admin-config-field">
                  <label htmlFor={`storage-${field.key}`}>{field.label}</label>
                  {field.type === 'boolean' ? (
                    <input
                      id={`storage-${field.key}`}
                      type="checkbox"
                      checked={Boolean(settings[field.key])}
                      onChange={(e) =>
                        setSettings((prev) => ({ ...prev, [field.key]: e.target.checked }))
                      }
                    />
                  ) : (
                    <input
                      id={`storage-${field.key}`}
                      type="number"
                      value={Number(settings[field.key] ?? 0)}
                      onChange={(e) =>
                        setSettings((prev) => ({ ...prev, [field.key]: Number(e.target.value) }))
                      }
                    />
                  )}
                  {field.hint && <span className="assistant-admin-config-hint">{field.hint}</span>}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="assistant-admin-save-btn"
              onClick={saveSettings}
              disabled={saving}
            >
              <Save size={16} /> {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  ShieldOff,
  Unlink,
  Upload,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/shadcn/sheet';
import { AssistantAdminStatCard } from '@/components/assistant/admin/AssistantAdminStatCard';

interface Capability {
  id: string;
  name: string;
  localName: string;
  description: string;
  effect: string;
  approvalPolicy: string;
  dataScope: string[];
  timeoutMs: number;
  connectionScope: string;
  reviewStatus: string;
  enabled: boolean;
  remoteChanged: boolean;
}

interface ExtensionDetail {
  id: string;
  namespace: string;
  kind: string;
  name: string;
  description: string | null;
  status: string;
  allowedRoleKeys: string[];
  allowedHosts: string[];
  suspendedReason: string | null;
  currentVersionId: string | null;
  versions: Array<{
    id: string;
    version: string;
    status: string;
    reviewNotes: string | null;
    approvedAt: string | null;
    lastTestedAt: string | null;
    lastTestResult: unknown;
    createdAt: string;
    capabilities: Capability[];
  }>;
  executions30d: Record<string, number>;
}

interface ConnectionRow {
  id: string;
  scopeType: string;
  authType: string;
  name: string;
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
}

const EFFECTS = [
  'read',
  'draft',
  'internal_task',
  'external_send',
  'business_write',
  'destructive',
];

const STATUS_ACTIONS: Record<string, Array<{ to: string; label: string }>> = {
  draft: [{ to: 'pending_approval', label: 'Enviar a aprobación' }],
  testing: [{ to: 'pending_approval', label: 'Enviar a aprobación' }],
  pending_approval: [{ to: 'draft', label: 'Devolver a borrador' }],
  approved: [{ to: 'enabled', label: 'Habilitar' }],
  enabled: [],
  suspended: [{ to: 'enabled', label: 'Reactivar' }],
  revoked: [],
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  testing: 'En pruebas',
  pending_approval: 'Por aprobar',
  approved: 'Aprobada',
  enabled: 'Habilitada',
  suspended: 'Suspendida',
  revoked: 'Revocada',
  active: 'Activa',
  success: 'Éxito',
  failed: 'Falló',
};

const KIND_LABELS: Record<string, string> = {
  mcp: 'MCP',
  api: 'API',
  plugin: 'Plugin',
  skill: 'Skill',
};

export function badgeClass(status: string): string {
  if (['enabled', 'approved', 'success', 'active', 'published', 'executed'].includes(status))
    return 'assistant-admin-badge assistant-admin-badge-success';
  if (['suspended', 'revoked', 'error', 'failed', 'denied', 'timeout', 'blocked'].includes(status))
    return 'assistant-admin-badge assistant-admin-badge-error';
  return 'assistant-admin-badge';
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleString('es-MX') : '—');

/**
 * Extension detail drawer: status flow, connections, OpenAPI import, plugin
 * upload, versions + capability governance, and the test runner. Loads itself
 * from `extensionId`; calls `onChanged` after any mutation.
 */
export function ExtensionDetailDrawer({
  extensionId,
  canManage,
  onOpenChange,
  onChanged,
}: {
  extensionId: string | null;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ExtensionDetail | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [openApiText, setOpenApiText] = useState('');
  const [openApiPreview, setOpenApiPreview] = useState<Array<{
    operationId: string;
    method: string;
    path: string;
    summary: string;
    suggestedEffect: string;
  }> | null>(null);
  const [selectedOps, setSelectedOps] = useState<string[]>([]);
  const [teamConn, setTeamConn] = useState({
    authType: 'api_key',
    name: 'Cuenta de equipo',
    apiKey: '',
    accessToken: '',
    clientSecret: '',
  });
  const [testState, setTestState] = useState<{
    capabilityId: string;
    args: string;
    fixture: string;
    confirmWrite: boolean;
    result?: unknown;
  }>({ capabilityId: '', args: '{}', fixture: '', confirmWrite: false });

  const loadDetail = useCallback(async (id: string) => {
    const data = await api<{ extension: ExtensionDetail }>(`/app/assistant/api/extensions/${id}`);
    setDetail(data.extension);
    const conns = await api<{ connections: ConnectionRow[] }>(
      `/app/assistant/api/extensions/${id}/connections`
    );
    setConnections(conns.connections);
  }, []);

  useEffect(() => {
    setDetail(null);
    setConnections([]);
    setError(null);
    setNotice(null);
    setOpenApiPreview(null);
    setOpenApiText('');
    setSelectedOps([]);
    setTestState({ capabilityId: '', args: '{}', fixture: '', confirmWrite: false });
    if (!extensionId) return;
    setLoading(true);
    loadDetail(extensionId)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
      .finally(() => setLoading(false));
  }, [extensionId, loadDetail]);

  const run = useCallback(
    async (fn: () => Promise<void>, ok?: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await fn();
        if (ok) setNotice(ok);
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error');
      } finally {
        setBusy(false);
      }
    },
    [onChanged]
  );

  async function transition(status: string, reason?: string) {
    if (!detail) return;
    await run(
      async () => {
        await api(`/app/admin/extensions/api/extensions/${detail.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({ status, reason }),
        });
        await loadDetail(detail.id);
      },
      `Estado cambiado a ${statusLabel(status)}`
    );
  }

  async function reviewCapability(capabilityId: string, patch: Record<string, unknown>) {
    if (!detail) return;
    await run(async () => {
      await api(`/app/admin/extensions/api/capabilities/${capabilityId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadDetail(detail.id);
    });
  }

  async function approveVersion(versionId: string, enable: boolean) {
    if (!detail) return;
    await run(
      async () => {
        await api(`/app/assistant/api/extensions/${detail.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ versionId, enable }),
        });
        await loadDetail(detail.id);
      },
      enable ? 'Versión aprobada y extensión habilitada' : 'Versión aprobada'
    );
  }

  async function syncMcp() {
    if (!detail) return;
    await run(async () => {
      const r = await api<{
        added: string[];
        changed: string[];
        removed: string[];
        unchanged: string[];
      }>(`/app/admin/extensions/api/extensions/${detail.id}/mcp-sync`, { method: 'POST' });
      setNotice(
        `Catálogo sincronizado: +${r.added.length} nuevas, ~${r.changed.length} cambiadas, -${r.removed.length} eliminadas, ${r.unchanged.length} sin cambios`
      );
      await loadDetail(detail.id);
    });
  }

  async function previewOpenApi() {
    if (!detail) return;
    await run(async () => {
      const document = JSON.parse(openApiText);
      const r = await api<{ operations: typeof openApiPreview; warnings: string[] }>(
        `/app/admin/extensions/api/extensions/${detail.id}/openapi`,
        { method: 'POST', body: JSON.stringify({ document, preview: true }) }
      );
      setOpenApiPreview(r.operations);
      setSelectedOps((r.operations ?? []).map((o) => o.operationId));
      if (r.warnings.length > 0) setNotice(`Avisos: ${r.warnings.join(' · ')}`);
    });
  }

  async function importOpenApi() {
    if (!detail) return;
    await run(async () => {
      const document = JSON.parse(openApiText);
      await api(`/app/admin/extensions/api/extensions/${detail.id}/openapi`, {
        method: 'POST',
        body: JSON.stringify({ document, selected: selectedOps }),
      });
      setOpenApiPreview(null);
      await loadDetail(detail.id);
    }, 'Operaciones importadas como nueva versión (borrador)');
  }

  async function uploadPlugin(file: File) {
    if (!detail) return;
    await run(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ versionId: string; reused: boolean; warnings: string[] }>(
        `/app/admin/extensions/api/extensions/${detail.id}/plugin`,
        { method: 'POST', body: fd }
      );
      setNotice(
        r.reused
          ? 'Ese paquete ya estaba instalado (mismo contenido)'
          : `Plugin instalado como versión borrador${r.warnings.length ? ` · avisos: ${r.warnings.join(' · ')}` : ''}`
      );
      await loadDetail(detail.id);
    });
  }

  async function createTeamConnection() {
    if (!detail) return;
    await run(async () => {
      const secret: Record<string, string> = {};
      if (teamConn.authType === 'api_key') secret.apiKey = teamConn.apiKey;
      if (teamConn.authType === 'bearer') secret.accessToken = teamConn.accessToken;
      if (teamConn.authType === 'service') secret.clientSecret = teamConn.clientSecret;
      await api(`/app/assistant/api/extensions/${detail.id}/connections`, {
        method: 'POST',
        body: JSON.stringify({
          scopeType: 'team',
          authType: teamConn.authType,
          name: teamConn.name,
          secret,
        }),
      });
      setTeamConn({
        authType: 'api_key',
        name: 'Cuenta de equipo',
        apiKey: '',
        accessToken: '',
        clientSecret: '',
      });
      await loadDetail(detail.id);
    }, 'Conexión guardada (el secreto no se vuelve a mostrar)');
  }

  async function revokeConnection(id: string) {
    if (!detail) return;
    await run(async () => {
      await api(`/app/assistant/api/extensions/${detail.id}/connections/${id}`, {
        method: 'DELETE',
      });
      await loadDetail(detail.id);
    }, 'Conexión revocada');
  }

  async function runTest() {
    if (!detail || !testState.capabilityId) return;
    await run(async () => {
      const args = testState.args ? JSON.parse(testState.args) : {};
      const r = await api<{ result: unknown }>(`/app/assistant/api/extensions/${detail.id}/test`, {
        method: 'POST',
        body: JSON.stringify({
          capabilityId: testState.capabilityId,
          args,
          fixture: testState.fixture || undefined,
          confirmWrite: testState.confirmWrite,
        }),
      });
      setTestState((prev) => ({ ...prev, result: r.result }));
    });
  }

  const hasCapabilities = detail?.versions.some((v) => v.capabilities.length > 0) ?? false;

  return (
    <Sheet open={extensionId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        {loading || !detail ? (
          <div className="assistant-admin-loading">
            {error ?? (
              <>
                <Loader2 size={16} className="copilot-spin" /> Cargando extensión…
              </>
            )}
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="ext-drawer-title">
                {detail.name}
                <span className={badgeClass(detail.status)}>{statusLabel(detail.status)}</span>
              </SheetTitle>
              <SheetDescription>
                {KIND_LABELS[detail.kind] ?? detail.kind.toUpperCase()} · {detail.namespace}
              </SheetDescription>
            </SheetHeader>

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

            <dl className="ext-meta">
              <div>
                <dt>Dominios</dt>
                <dd>{detail.allowedHosts.join(', ') || '—'}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>{detail.allowedRoleKeys.join(', ') || 'solo super administradores'}</dd>
              </div>
              {detail.suspendedReason ? (
                <div>
                  <dt>Motivo de suspensión</dt>
                  <dd>{detail.suspendedReason}</dd>
                </div>
              ) : null}
            </dl>

            {Object.keys(detail.executions30d).length > 0 && (
              <div className="assistant-admin-stat-grid">
                {Object.entries(detail.executions30d).map(([k, v]) => (
                  <AssistantAdminStatCard key={k} label={`Ejecuciones ${k} (30d)`} value={v} />
                ))}
              </div>
            )}

            {canManage && (
              <div className="ext-actions">
                {(STATUS_ACTIONS[detail.status] ?? []).map((a) => (
                  <button
                    key={a.to}
                    type="button"
                    className="assistant-admin-test-btn"
                    disabled={busy}
                    onClick={() => void transition(a.to)}
                  >
                    {a.label}
                  </button>
                ))}
                {detail.kind === 'mcp' && (
                  <button
                    type="button"
                    className="assistant-admin-test-btn"
                    disabled={busy}
                    onClick={() => void syncMcp()}
                  >
                    <RefreshCw size={14} /> Descubrir herramientas
                  </button>
                )}
                {detail.status !== 'revoked' && (
                  <button
                    type="button"
                    className="assistant-admin-test-btn danger"
                    disabled={busy}
                    onClick={() => void transition('revoked', 'Desinstalada desde el panel')}
                  >
                    <ShieldOff size={14} /> Desinstalar
                  </button>
                )}
              </div>
            )}

            {canManage && detail.kind === 'api' && (
              <section className="assistant-admin-config-section">
                <h4>Importar OpenAPI 3.x (JSON)</h4>
                <textarea
                  className="assistant-admin-filter-input"
                  rows={6}
                  value={openApiText}
                  onChange={(e) => setOpenApiText(e.target.value)}
                  placeholder='{"openapi":"3.0.3", ...}'
                  aria-label="Documento OpenAPI"
                />
                <div className="assistant-admin-filters">
                  <button
                    type="button"
                    className="assistant-admin-test-btn"
                    disabled={busy || !openApiText}
                    onClick={() => void previewOpenApi()}
                  >
                    Previsualizar operaciones
                  </button>
                  {openApiPreview && (
                    <button
                      type="button"
                      className="assistant-admin-save-btn"
                      disabled={busy || selectedOps.length === 0}
                      onClick={() => void importOpenApi()}
                    >
                      Importar {selectedOps.length} operaciones
                    </button>
                  )}
                </div>
                {openApiPreview && (
                  <div className="assistant-admin-list">
                    {openApiPreview.map((o) => (
                      <label key={o.operationId} className="assistant-admin-list-item">
                        <input
                          type="checkbox"
                          checked={selectedOps.includes(o.operationId)}
                          onChange={(e) =>
                            setSelectedOps((prev) =>
                              e.target.checked
                                ? [...prev, o.operationId]
                                : prev.filter((x) => x !== o.operationId)
                            )
                          }
                        />
                        <span className="assistant-admin-list-name">
                          {o.method} {o.path}
                        </span>
                        <span className="assistant-admin-list-meta">
                          {o.summary} · sugerido: {o.suggestedEffect}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </section>
            )}

            {canManage && detail.kind === 'plugin' && (
              <section className="assistant-admin-config-section">
                <h4>Instalar paquete de plugin (.zip con manifest.json)</h4>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  aria-label="Paquete de plugin"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadPlugin(f);
                    e.target.value = '';
                  }}
                />
                <p className="assistant-admin-config-hint">
                  <Upload size={12} /> Sin secretos ni código: manifiesto, skills declarativas,
                  operaciones, plantillas, documentación y fixtures.
                </p>
              </section>
            )}

            <section className="assistant-admin-config-section">
              <h4>
                <KeyRound size={14} /> Conexiones
              </h4>
              <div className="assistant-admin-table-wrap">
                <table className="assistant-admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Ámbito</th>
                      <th>Tipo</th>
                      <th>Estado</th>
                      <th>Vence</th>
                      <th>Último uso</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {connections.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.scopeType === 'team' ? 'Equipo' : 'Personal'}</td>
                        <td>{c.authType}</td>
                        <td>
                          <span className={badgeClass(c.status)}>{statusLabel(c.status)}</span>
                          {c.lastError ? (
                            <div className="assistant-admin-list-meta">{c.lastError}</div>
                          ) : null}
                        </td>
                        <td>{fmtDate(c.expiresAt)}</td>
                        <td>{fmtDate(c.lastUsedAt)}</td>
                        <td>
                          {canManage && c.status === 'active' && (
                            <button
                              type="button"
                              className="assistant-admin-test-btn danger"
                              disabled={busy}
                              onClick={() => void revokeConnection(c.id)}
                            >
                              <Unlink size={12} /> Revocar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {connections.length === 0 && (
                      <tr>
                        <td colSpan={7} className="assistant-admin-muted">
                          Sin conexiones — agrega una cuenta de equipo abajo.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {canManage && (
                <div className="assistant-admin-config-grid">
                  <div className="assistant-admin-config-field">
                    <label htmlFor="conn-type">Nueva conexión de equipo</label>
                    <select
                      id="conn-type"
                      className="assistant-admin-select"
                      value={teamConn.authType}
                      onChange={(e) => setTeamConn({ ...teamConn, authType: e.target.value })}
                    >
                      <option value="api_key">API key</option>
                      <option value="bearer">Bearer token</option>
                      <option value="service">OAuth client secret (servicio)</option>
                    </select>
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="conn-name">Nombre</label>
                    <input
                      id="conn-name"
                      value={teamConn.name}
                      onChange={(e) => setTeamConn({ ...teamConn, name: e.target.value })}
                    />
                  </div>
                  {teamConn.authType === 'api_key' && (
                    <div className="assistant-admin-config-field">
                      <label htmlFor="conn-key">API key</label>
                      <input
                        id="conn-key"
                        type="password"
                        autoComplete="off"
                        value={teamConn.apiKey}
                        onChange={(e) => setTeamConn({ ...teamConn, apiKey: e.target.value })}
                      />
                    </div>
                  )}
                  {teamConn.authType === 'bearer' && (
                    <div className="assistant-admin-config-field">
                      <label htmlFor="conn-tok">Token</label>
                      <input
                        id="conn-tok"
                        type="password"
                        autoComplete="off"
                        value={teamConn.accessToken}
                        onChange={(e) => setTeamConn({ ...teamConn, accessToken: e.target.value })}
                      />
                    </div>
                  )}
                  {teamConn.authType === 'service' && (
                    <div className="assistant-admin-config-field">
                      <label htmlFor="conn-cs">Client secret</label>
                      <input
                        id="conn-cs"
                        type="password"
                        autoComplete="off"
                        value={teamConn.clientSecret}
                        onChange={(e) => setTeamConn({ ...teamConn, clientSecret: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="assistant-admin-config-field">
                    <label>&nbsp;</label>
                    <button
                      type="button"
                      className="assistant-admin-save-btn"
                      disabled={busy}
                      onClick={() => void createTeamConnection()}
                    >
                      Guardar conexión
                    </button>
                  </div>
                </div>
              )}
            </section>

            {detail.versions.map((v) => (
              <section key={v.id} className="assistant-admin-config-section">
                <h4>
                  Versión {v.version} ·{' '}
                  <span className={badgeClass(v.status)}>{statusLabel(v.status)}</span>
                  {detail.currentVersionId === v.id ? ' · en uso' : ''} ·{' '}
                  {new Date(v.createdAt).toLocaleString('es-MX')}
                  {v.lastTestedAt
                    ? ` · probada ${new Date(v.lastTestedAt).toLocaleString('es-MX')}`
                    : ''}
                </h4>
                {v.reviewNotes && <p className="assistant-admin-muted">{v.reviewNotes}</p>}
                {canManage && v.status !== 'superseded' && detail.currentVersionId !== v.id && (
                  <div className="assistant-admin-filters">
                    <button
                      type="button"
                      className="assistant-admin-test-btn"
                      disabled={busy}
                      onClick={() => void approveVersion(v.id, false)}
                    >
                      Aprobar versión
                    </button>
                    <button
                      type="button"
                      className="assistant-admin-save-btn"
                      disabled={busy}
                      onClick={() => void approveVersion(v.id, true)}
                    >
                      Aprobar y habilitar
                    </button>
                  </div>
                )}
                <div className="assistant-admin-table-wrap">
                  <table className="assistant-admin-table">
                    <thead>
                      <tr>
                        <th>Capacidad</th>
                        <th>Efecto</th>
                        <th>Aprobación</th>
                        <th>Conexión</th>
                        <th>Timeout</th>
                        <th>Revisión</th>
                        <th>Habilitada</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.capabilities.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.localName}
                            <div className="assistant-admin-list-meta">
                              {c.description.slice(0, 160)}
                            </div>
                            {c.remoteChanged && (
                              <span className="assistant-admin-badge assistant-admin-badge-error">
                                cambió en el servidor
                              </span>
                            )}
                          </td>
                          <td>
                            <select
                              className="assistant-admin-select"
                              disabled={!canManage}
                              value={c.effect}
                              onChange={(e) =>
                                void reviewCapability(c.id, { effect: e.target.value })
                              }
                              aria-label={`Efecto de ${c.localName}`}
                            >
                              {EFFECTS.map((ef) => (
                                <option key={ef} value={ef}>
                                  {ef}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              className="assistant-admin-select"
                              disabled={!canManage}
                              value={c.approvalPolicy}
                              onChange={(e) =>
                                void reviewCapability(c.id, { approvalPolicy: e.target.value })
                              }
                              aria-label={`Aprobación de ${c.localName}`}
                            >
                              <option value="require_approval">requiere aprobación</option>
                              <option value="auto">automática</option>
                            </select>
                          </td>
                          <td>
                            <select
                              className="assistant-admin-select"
                              disabled={!canManage}
                              value={c.connectionScope}
                              onChange={(e) =>
                                void reviewCapability(c.id, { connectionScope: e.target.value })
                              }
                              aria-label={`Conexión de ${c.localName}`}
                            >
                              <option value="none">ninguna</option>
                              <option value="team">equipo</option>
                              <option value="personal">personal</option>
                            </select>
                          </td>
                          <td>{c.timeoutMs} ms</td>
                          <td>
                            <select
                              className="assistant-admin-select"
                              disabled={!canManage}
                              value={c.reviewStatus}
                              onChange={(e) =>
                                void reviewCapability(c.id, {
                                  reviewStatus: e.target.value,
                                  ...(e.target.value !== 'approved' ? { enabled: false } : {}),
                                })
                              }
                              aria-label={`Revisión de ${c.localName}`}
                            >
                              <option value="pending">pendiente</option>
                              <option value="approved">aprobada</option>
                              <option value="blocked">bloqueada</option>
                            </select>
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              disabled={!canManage || c.reviewStatus !== 'approved'}
                              checked={c.enabled}
                              onChange={(e) =>
                                void reviewCapability(c.id, { enabled: e.target.checked })
                              }
                              aria-label={`Habilitar ${c.localName}`}
                            />
                          </td>
                        </tr>
                      ))}
                      {v.capabilities.length === 0 && (
                        <tr>
                          <td colSpan={7} className="assistant-admin-muted">
                            Sin capacidades (sincroniza o importa)
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}

            {canManage && hasCapabilities && (
              <section className="assistant-admin-config-section">
                <h4>
                  <Play size={14} /> Probar una capacidad (con fixture o en vivo)
                </h4>
                <div className="assistant-admin-config-grid">
                  <div className="assistant-admin-config-field">
                    <label htmlFor="test-cap">Capacidad</label>
                    <select
                      id="test-cap"
                      className="assistant-admin-select"
                      value={testState.capabilityId}
                      onChange={(e) =>
                        setTestState({
                          ...testState,
                          capabilityId: e.target.value,
                          result: undefined,
                        })
                      }
                    >
                      <option value="">—</option>
                      {detail.versions.flatMap((v) =>
                        v.capabilities.map((c) => (
                          <option key={c.id} value={c.id}>
                            {v.version} · {c.localName}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="test-args">Argumentos (JSON)</label>
                    <input
                      id="test-args"
                      value={testState.args}
                      onChange={(e) => setTestState({ ...testState, args: e.target.value })}
                    />
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="test-fix">Fixture (opcional)</label>
                    <input
                      id="test-fix"
                      value={testState.fixture}
                      onChange={(e) => setTestState({ ...testState, fixture: e.target.value })}
                    />
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="test-confirm">Confirmar escritura real</label>
                    <input
                      id="test-confirm"
                      type="checkbox"
                      checked={testState.confirmWrite}
                      onChange={(e) =>
                        setTestState({ ...testState, confirmWrite: e.target.checked })
                      }
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="assistant-admin-test-btn"
                  disabled={busy || !testState.capabilityId}
                  onClick={() => void runTest()}
                >
                  Ejecutar prueba
                </button>
                {testState.result !== undefined && (
                  <pre className="assistant-admin-test-result">
                    {JSON.stringify(testState.result, null, 2)}
                  </pre>
                )}
              </section>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

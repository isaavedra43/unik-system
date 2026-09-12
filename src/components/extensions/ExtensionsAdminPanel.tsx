'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Plug, RefreshCw, ShieldOff, Upload } from 'lucide-react';
import { AssistantAdminStatCard } from '@/components/assistant/admin/AssistantAdminStatCard';

/**
 * Administration of assistant extensions. Tabs:
 * Catálogo · Conexiones · MCP · APIs · Skills · Plugins · Ejecuciones · Consumo
 * Every mutation goes through server routes that re-check `extensions.manage`.
 */

interface ExtensionRow {
  id: string;
  namespace: string;
  kind: string;
  name: string;
  description: string | null;
  status: string;
  createdBy: string;
  currentVersionId: string | null;
  allowedRoleKeys: string[];
  allowedHosts: string[];
  allowedPorts: number[];
  config: Record<string, unknown> | null;
  suspendedReason: string | null;
  updatedAt: string;
  versions: Array<{
    id: string;
    version: string;
    status: string;
    createdAt: string;
    approvedAt: string | null;
    lastTestedAt: string | null;
  }>;
  counts: { capabilities: number; connections: number; executions: number };
}

interface Capability {
  id: string;
  name: string;
  localName: string;
  description: string;
  effect: string;
  approvalPolicy: string;
  dataScope: string[];
  timeoutMs: number;
  maxResultBytes: number;
  connectionScope: string;
  reviewStatus: string;
  enabled: boolean;
  remoteChanged: boolean;
  inputSchema: unknown;
}

interface ExtensionDetail extends Omit<ExtensionRow, 'versions' | 'counts'> {
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
  ownerUserId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
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

interface SkillRow {
  id: string;
  key: string;
  name: string;
  purpose: string;
  scope: string;
  status: string;
  version: number;
  ownerUserId: string;
  updatedAt: string;
}

type TabId =
  'catalog' | 'connections' | 'mcp' | 'apis' | 'skills' | 'plugins' | 'executions' | 'usage';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'catalog', label: 'Catálogo' },
  { id: 'connections', label: 'Conexiones' },
  { id: 'mcp', label: 'MCP' },
  { id: 'apis', label: 'APIs' },
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'executions', label: 'Ejecuciones' },
  { id: 'usage', label: 'Consumo' },
];

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

function badgeClass(status: string): string {
  if (['enabled', 'approved', 'success', 'active', 'published', 'executed'].includes(status))
    return 'assistant-admin-badge assistant-admin-badge-success';
  if (['suspended', 'revoked', 'error', 'failed', 'denied', 'timeout', 'blocked'].includes(status))
    return 'assistant-admin-badge assistant-admin-badge-error';
  return 'assistant-admin-badge';
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

export function ExtensionsAdminPanel({
  canManage,
  canPublishSkills,
}: {
  canManage: boolean;
  canPublishSkills: boolean;
}) {
  const [tab, setTab] = useState<TabId>('catalog');
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExtensionDetail | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    kind: 'mcp',
    namespace: '',
    name: '',
    description: '',
    allowedHosts: '',
    allowedRoleKeys: '',
    url: '',
    apiKeyHeader: 'X-API-Key',
  });
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

  const run = useCallback(async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const data = await api<{ extensions: ExtensionRow[] }>('/app/assistant/api/extensions');
      setExtensions(data.extensions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const data = await api<{ extension: ExtensionDetail }>(`/app/assistant/api/extensions/${id}`);
    setDetail(data.extension);
    const conns = await api<{ connections: ConnectionRow[] }>(
      `/app/assistant/api/extensions/${id}/connections`
    );
    setConnections(conns.connections);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId)
      loadDetail(selectedId).catch((e) => setError(e instanceof Error ? e.message : 'Error'));
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (tab === 'executions')
      api<{ executions: ExecutionRow[] }>('/app/admin/extensions/api/executions')
        .then((d) => setExecutions(d.executions))
        .catch(() => undefined);
    if (tab === 'usage')
      api<{ usage: UsageRow[] }>('/app/admin/extensions/api/usage?dimension=extension')
        .then((d) => setUsage(d.usage))
        .catch(() => undefined);
    if (tab === 'skills')
      api<{ skills: SkillRow[] }>('/app/admin/extensions/api/skills')
        .then((d) => setSkills(d.skills))
        .catch(() => undefined);
  }, [tab]);

  const kindFilter: Record<TabId, string | null> = {
    catalog: null,
    connections: null,
    mcp: 'mcp',
    apis: 'api',
    skills: 'skill',
    plugins: 'plugin',
    executions: null,
    usage: null,
  };
  const visible = extensions.filter((e) => !kindFilter[tab] || e.kind === kindFilter[tab]);

  async function createExtension(kind: string) {
    const config: Record<string, unknown> = {};
    if (kind === 'mcp') config.mcp = { url: form.url, connectionScope: 'team' };
    if (kind === 'api' || kind === 'plugin')
      config.api = { baseUrl: form.url, apiKeyHeader: form.apiKeyHeader };
    await run(async () => {
      await api('/app/assistant/api/extensions', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          namespace: form.namespace,
          name: form.name,
          description: form.description || undefined,
          allowedHosts: form.allowedHosts
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean),
          allowedRoleKeys: form.allowedRoleKeys
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
          config: kind === 'plugin' && !form.url ? {} : config,
        }),
      });
      setForm({
        kind,
        namespace: '',
        name: '',
        description: '',
        allowedHosts: '',
        allowedRoleKeys: '',
        url: '',
        apiKeyHeader: 'X-API-Key',
      });
      await loadList();
    }, 'Extensión creada en borrador');
  }

  async function transition(id: string, status: string, reason?: string) {
    await run(async () => {
      await api(`/app/admin/extensions/api/extensions/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status, reason }),
      });
      await loadList();
      if (selectedId === id) await loadDetail(id);
    }, `Estado cambiado a ${status}`);
  }

  async function reviewCapability(capabilityId: string, patch: Record<string, unknown>) {
    if (!selectedId) return;
    await run(async () => {
      await api(`/app/admin/extensions/api/capabilities/${capabilityId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await loadDetail(selectedId);
    });
  }

  async function approveVersion(versionId: string, enable: boolean) {
    if (!selectedId) return;
    await run(
      async () => {
        await api(`/app/assistant/api/extensions/${selectedId}/approve`, {
          method: 'POST',
          body: JSON.stringify({ versionId, enable }),
        });
        await loadList();
        await loadDetail(selectedId);
      },
      enable ? 'Versión aprobada y extensión habilitada' : 'Versión aprobada'
    );
  }

  async function syncMcp() {
    if (!selectedId) return;
    await run(async () => {
      const r = await api<{
        added: string[];
        changed: string[];
        removed: string[];
        unchanged: string[];
      }>(`/app/admin/extensions/api/extensions/${selectedId}/mcp-sync`, { method: 'POST' });
      setNotice(
        `Catálogo sincronizado: +${r.added.length} nuevas, ~${r.changed.length} cambiadas, -${r.removed.length} eliminadas, ${r.unchanged.length} sin cambios`
      );
      await loadDetail(selectedId);
    });
  }

  async function previewOpenApi() {
    if (!selectedId) return;
    await run(async () => {
      const document = JSON.parse(openApiText);
      const r = await api<{ operations: typeof openApiPreview; warnings: string[] }>(
        `/app/admin/extensions/api/extensions/${selectedId}/openapi`,
        { method: 'POST', body: JSON.stringify({ document, preview: true }) }
      );
      setOpenApiPreview(r.operations);
      setSelectedOps((r.operations ?? []).map((o) => o.operationId));
      if (r.warnings.length > 0) setNotice(`Avisos: ${r.warnings.join(' · ')}`);
    });
  }

  async function importOpenApi() {
    if (!selectedId) return;
    await run(async () => {
      const document = JSON.parse(openApiText);
      await api(`/app/admin/extensions/api/extensions/${selectedId}/openapi`, {
        method: 'POST',
        body: JSON.stringify({ document, selected: selectedOps }),
      });
      setOpenApiPreview(null);
      await loadDetail(selectedId);
    }, 'Operaciones importadas como nueva versión (borrador)');
  }

  async function uploadPlugin(file: File) {
    if (!selectedId) return;
    await run(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ versionId: string; reused: boolean; warnings: string[] }>(
        `/app/admin/extensions/api/extensions/${selectedId}/plugin`,
        { method: 'POST', body: fd }
      );
      setNotice(
        r.reused
          ? 'Ese paquete ya estaba instalado (mismo contenido)'
          : `Plugin instalado como versión borrador${r.warnings.length ? ` · avisos: ${r.warnings.join(' · ')}` : ''}`
      );
      await loadDetail(selectedId);
    });
  }

  async function createTeamConnection() {
    if (!selectedId) return;
    await run(async () => {
      const secret: Record<string, string> = {};
      if (teamConn.authType === 'api_key') secret.apiKey = teamConn.apiKey;
      if (teamConn.authType === 'bearer') secret.accessToken = teamConn.accessToken;
      if (teamConn.authType === 'service') secret.clientSecret = teamConn.clientSecret;
      await api(`/app/assistant/api/extensions/${selectedId}/connections`, {
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
      await loadDetail(selectedId);
    }, 'Conexión guardada (el secreto no se vuelve a mostrar)');
  }

  async function revokeConnection(id: string) {
    if (!selectedId) return;
    await run(async () => {
      await api(`/app/assistant/api/extensions/${selectedId}/connections/${id}`, {
        method: 'DELETE',
      });
      await loadDetail(selectedId);
    }, 'Conexión revocada');
  }

  async function runTest() {
    if (!selectedId || !testState.capabilityId) return;
    await run(async () => {
      const args = testState.args ? JSON.parse(testState.args) : {};
      const r = await api<{ result: unknown }>(`/app/assistant/api/extensions/${selectedId}/test`, {
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

  async function setSkillStatus(id: string, status: string) {
    await run(async () => {
      await api(`/app/admin/extensions/api/skills/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      const d = await api<{ skills: SkillRow[] }>('/app/admin/extensions/api/skills');
      setSkills(d.skills);
    }, `Skill ${status}`);
  }

  if (loading) return <div className="assistant-admin-loading">Cargando…</div>;

  const showCreate = canManage && (tab === 'mcp' || tab === 'apis' || tab === 'plugins');
  const createKind = tab === 'mcp' ? 'mcp' : tab === 'apis' ? 'api' : 'plugin';

  return (
    <div className="assistant-admin-panel">
      <div className="assistant-admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`assistant-admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
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
        {tab === 'executions' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Ejecuciones externas (auditoría)</h3>
            <div className="assistant-admin-table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Herramienta</th>
                    <th>Estado</th>
                    <th>ms</th>
                    <th>Bytes</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((x) => (
                    <tr key={x.id}>
                      <td>{new Date(x.createdAt).toLocaleString('es-MX')}</td>
                      <td>{x.toolName}</td>
                      <td>
                        <span className={badgeClass(x.status)}>{x.status}</span>
                      </td>
                      <td>{x.durationMs}</td>
                      <td>{x.requestBytes + x.responseBytes}</td>
                      <td className="assistant-admin-msg-preview">
                        {x.errorMessage ?? x.errorCode ?? ''}
                      </td>
                    </tr>
                  ))}
                  {executions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="assistant-admin-muted">
                        Sin ejecuciones
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'usage' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Consumo por extensión (diario)</h3>
            <div className="assistant-admin-table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Día</th>
                    <th>Extensión</th>
                    <th>Unidad</th>
                    <th>Eventos</th>
                    <th>Cantidad</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u, i) => (
                    <tr key={i}>
                      <td>{u.period}</td>
                      <td>{extensions.find((e) => e.id === u.key)?.name ?? u.key}</td>
                      <td>{u.unit}</td>
                      <td>{u.count}</td>
                      <td>{u.amount}</td>
                    </tr>
                  ))}
                  {usage.length === 0 && (
                    <tr>
                      <td colSpan={5} className="assistant-admin-muted">
                        Sin consumo registrado
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'skills' && (
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Skills de equipo y personales</h3>
            <p className="assistant-admin-muted">
              Las skills son recetas declarativas (sin código). Publicar una skill de equipo
              requiere el permiso skills.manage.
            </p>
            <div className="assistant-admin-table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Clave</th>
                    <th>Nombre</th>
                    <th>Ámbito</th>
                    <th>Estado</th>
                    <th>Versión</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={s.id}>
                      <td>{s.key}</td>
                      <td>
                        {s.name}
                        <div className="assistant-admin-list-meta">{s.purpose}</div>
                      </td>
                      <td>{s.scope}</td>
                      <td>
                        <span className={badgeClass(s.status)}>{s.status}</span>
                      </td>
                      <td>{s.version}</td>
                      <td>
                        {canPublishSkills && s.scope === 'team' && s.status !== 'published' && (
                          <button
                            type="button"
                            className="assistant-admin-test-btn"
                            disabled={busy}
                            onClick={() => setSkillStatus(s.id, 'published')}
                          >
                            Publicar
                          </button>
                        )}
                        {canPublishSkills && s.scope === 'team' && s.status === 'published' && (
                          <button
                            type="button"
                            className="assistant-admin-test-btn"
                            disabled={busy}
                            onClick={() => setSkillStatus(s.id, 'suspended')}
                          >
                            Suspender
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {skills.length === 0 && (
                    <tr>
                      <td colSpan={6} className="assistant-admin-muted">
                        Sin skills
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(tab === 'catalog' ||
          tab === 'connections' ||
          tab === 'mcp' ||
          tab === 'apis' ||
          tab === 'plugins') && (
          <>
            {showCreate && (
              <div className="assistant-admin-section">
                <h3 className="assistant-admin-section-title">
                  Nueva extensión {createKind.toUpperCase()}
                </h3>
                <div className="assistant-admin-config-grid">
                  <div className="assistant-admin-config-field">
                    <label htmlFor="ext-ns">Namespace</label>
                    <input
                      id="ext-ns"
                      value={form.namespace}
                      onChange={(e) => setForm({ ...form, namespace: e.target.value })}
                      placeholder="mcp.books"
                    />
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="ext-name">Nombre</label>
                    <input
                      id="ext-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="ext-url">
                      {createKind === 'mcp'
                        ? 'URL del servidor MCP (HTTPS)'
                        : 'URL base de la API (HTTPS)'}
                    </label>
                    <input
                      id="ext-url"
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="https://"
                    />
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="ext-hosts">Dominios aprobados (coma)</label>
                    <input
                      id="ext-hosts"
                      value={form.allowedHosts}
                      onChange={(e) => setForm({ ...form, allowedHosts: e.target.value })}
                      placeholder="api.proveedor.com, *.proveedor.com"
                    />
                  </div>
                  <div className="assistant-admin-config-field">
                    <label htmlFor="ext-roles">Roles autorizados (claves, coma)</label>
                    <input
                      id="ext-roles"
                      value={form.allowedRoleKeys}
                      onChange={(e) => setForm({ ...form, allowedRoleKeys: e.target.value })}
                      placeholder="ventas, super_admin"
                    />
                  </div>
                  {createKind !== 'mcp' && (
                    <div className="assistant-admin-config-field">
                      <label htmlFor="ext-hdr">Header de API key</label>
                      <input
                        id="ext-hdr"
                        value={form.apiKeyHeader}
                        onChange={(e) => setForm({ ...form, apiKeyHeader: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="assistant-admin-config-field">
                    <label htmlFor="ext-desc">Descripción</label>
                    <input
                      id="ext-desc"
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  className="assistant-admin-save-btn"
                  disabled={busy || !form.namespace || !form.name}
                  onClick={() => createExtension(createKind)}
                >
                  <Plug size={16} /> Crear borrador
                </button>
              </div>
            )}

            <div className="assistant-admin-section">
              <h3 className="assistant-admin-section-title">
                {tab === 'connections' ? 'Extensiones con conexiones' : 'Extensiones'}
              </h3>
              <div className="assistant-admin-table-wrap">
                <table className="assistant-admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Tipo</th>
                      <th>Estado</th>
                      <th>Publicó</th>
                      <th>Capacidades</th>
                      <th>Conexiones</th>
                      <th>Ejecuciones</th>
                      <th>Última prueba</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((e) => (
                      <tr
                        key={e.id}
                        className={`assistant-admin-row-clickable ${selectedId === e.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(e.id)}
                      >
                        <td>
                          {e.name}
                          <div className="assistant-admin-list-meta">{e.namespace}</div>
                        </td>
                        <td>{e.kind}</td>
                        <td>
                          <span className={badgeClass(e.status)}>{e.status}</span>
                        </td>
                        <td className="assistant-admin-muted">{e.createdBy.slice(0, 8)}</td>
                        <td>{e.counts.capabilities}</td>
                        <td>{e.counts.connections}</td>
                        <td>{e.counts.executions}</td>
                        <td>
                          {e.versions.find((v) => v.lastTestedAt)?.lastTestedAt
                            ? new Date(
                                e.versions.find((v) => v.lastTestedAt)!.lastTestedAt!
                              ).toLocaleString('es-MX')
                            : '—'}
                        </td>
                        <td>
                          {canManage && (e.status === 'enabled' || e.status === 'approved') && (
                            <button
                              type="button"
                              className="assistant-admin-test-btn"
                              disabled={busy}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                transition(
                                  e.id,
                                  'suspended',
                                  'Suspensión inmediata desde el panel'
                                );
                              }}
                            >
                              <ShieldOff size={14} /> Suspender
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {visible.length === 0 && (
                      <tr>
                        <td colSpan={9} className="assistant-admin-muted">
                          Sin extensiones
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {detail && (
              <div className="assistant-admin-section">
                <h3 className="assistant-admin-section-title">
                  {detail.name} · <span className={badgeClass(detail.status)}>{detail.status}</span>
                </h3>
                <p className="assistant-admin-muted">
                  {detail.kind.toUpperCase()} · namespace {detail.namespace} · dominios:{' '}
                  {detail.allowedHosts.join(', ') || '—'} · roles:{' '}
                  {detail.allowedRoleKeys.join(', ') || 'solo super_admin'}
                  {detail.suspendedReason ? ` · motivo: ${detail.suspendedReason}` : ''}
                </p>
                <div className="assistant-admin-stat-grid">
                  {Object.entries(detail.executions30d).map(([k, v]) => (
                    <AssistantAdminStatCard key={k} label={`Ejecuciones ${k} (30d)`} value={v} />
                  ))}
                </div>
                {canManage && (
                  <div className="assistant-admin-filters">
                    {(STATUS_ACTIONS[detail.status] ?? []).map((a) => (
                      <button
                        key={a.to}
                        type="button"
                        className="assistant-admin-test-btn"
                        disabled={busy}
                        onClick={() => transition(detail.id, a.to)}
                      >
                        {a.label}
                      </button>
                    ))}
                    {detail.status !== 'revoked' && (
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        disabled={busy}
                        onClick={() =>
                          transition(detail.id, 'revoked', 'Desinstalada desde el panel')
                        }
                      >
                        Desinstalar (revocar)
                      </button>
                    )}
                    {detail.kind === 'mcp' && (
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        disabled={busy}
                        onClick={syncMcp}
                      >
                        <RefreshCw size={14} /> Descubrir herramientas
                      </button>
                    )}
                  </div>
                )}

                {canManage && detail.kind === 'api' && (
                  <div className="assistant-admin-config-section">
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
                        onClick={previewOpenApi}
                      >
                        Previsualizar operaciones
                      </button>
                      {openApiPreview && (
                        <button
                          type="button"
                          className="assistant-admin-save-btn"
                          disabled={busy || selectedOps.length === 0}
                          onClick={importOpenApi}
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
                  </div>
                )}

                {canManage && detail.kind === 'plugin' && (
                  <div className="assistant-admin-config-section">
                    <h4>Instalar paquete de plugin (.zip con manifest.json)</h4>
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      aria-label="Paquete de plugin"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadPlugin(f);
                        e.target.value = '';
                      }}
                    />
                    <p className="assistant-admin-config-hint">
                      <Upload size={12} /> Sin secretos ni código: manifiesto, skills declarativas,
                      operaciones, plantillas, documentación y fixtures.
                    </p>
                  </div>
                )}

                <div className="assistant-admin-config-section">
                  <h4>Conexiones</h4>
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
                            <td>{c.scopeType}</td>
                            <td>{c.authType}</td>
                            <td>
                              <span className={badgeClass(c.status)}>{c.status}</span>
                              {c.lastError ? (
                                <div className="assistant-admin-list-meta">{c.lastError}</div>
                              ) : null}
                            </td>
                            <td>
                              {c.expiresAt ? new Date(c.expiresAt).toLocaleString('es-MX') : '—'}
                            </td>
                            <td>
                              {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString('es-MX') : '—'}
                            </td>
                            <td>
                              {canManage && c.status === 'active' && (
                                <button
                                  type="button"
                                  className="assistant-admin-test-btn"
                                  disabled={busy}
                                  onClick={() => revokeConnection(c.id)}
                                >
                                  Revocar
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                        {connections.length === 0 && (
                          <tr>
                            <td colSpan={7} className="assistant-admin-muted">
                              Sin conexiones
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
                            onChange={(e) =>
                              setTeamConn({ ...teamConn, accessToken: e.target.value })
                            }
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
                            onChange={(e) =>
                              setTeamConn({ ...teamConn, clientSecret: e.target.value })
                            }
                          />
                        </div>
                      )}
                      <div className="assistant-admin-config-field">
                        <label>&nbsp;</label>
                        <button
                          type="button"
                          className="assistant-admin-save-btn"
                          disabled={busy}
                          onClick={createTeamConnection}
                        >
                          Guardar conexión
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {detail.versions.map((v) => (
                  <div key={v.id} className="assistant-admin-config-section">
                    <h4>
                      Versión {v.version} · <span className={badgeClass(v.status)}>{v.status}</span>
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
                          onClick={() => approveVersion(v.id, false)}
                        >
                          Aprobar versión
                        </button>
                        <button
                          type="button"
                          className="assistant-admin-save-btn"
                          disabled={busy}
                          onClick={() => approveVersion(v.id, true)}
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
                                    reviewCapability(c.id, { effect: e.target.value })
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
                                    reviewCapability(c.id, { approvalPolicy: e.target.value })
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
                                    reviewCapability(c.id, { connectionScope: e.target.value })
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
                                    reviewCapability(c.id, {
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
                                    reviewCapability(c.id, { enabled: e.target.checked })
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
                  </div>
                ))}

                {canManage && detail.versions.some((v) => v.capabilities.length > 0) && (
                  <div className="assistant-admin-config-section">
                    <h4>Probar una capacidad (con fixture o en vivo)</h4>
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
                      onClick={runTest}
                    >
                      Ejecutar prueba
                    </button>
                    {testState.result !== undefined && (
                      <pre className="assistant-admin-test-result">
                        {JSON.stringify(testState.result, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Braces,
  CheckCircle2,
  Globe,
  KeyRound,
  Plug,
  Plus,
  Search,
} from 'lucide-react';
import { CatalogGrid, type ComposioAppItem } from './CatalogGrid';
import { MonitoringTab } from './MonitoringTab';
import { ComposioAdminTab } from './ComposioAdminTab';
import { NewExtensionSheet, type ExtensionForm } from './NewExtensionSheet';
import { ExtensionDetailDrawer, badgeClass, statusLabel } from './ExtensionDetailDrawer';
import type { CuratedEntry } from '@/modules/extensions/curated-catalog';

/**
 * Administration of assistant extensions. Tabs:
 * Catálogo · Composio · Extensiones · Monitoreo · Skills · Ejecuciones · Consumo
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
  config: Record<string, unknown> | null;
  suspendedReason: string | null;
  updatedAt: string;
  versions: Array<{ id: string; version: string; status: string; lastTestedAt: string | null }>;
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
  'catalog' | 'composio' | 'extensions' | 'monitoring' | 'skills' | 'executions' | 'usage';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'catalog', label: 'Catálogo' },
  { id: 'composio', label: 'Composio' },
  { id: 'extensions', label: 'Extensiones' },
  { id: 'monitoring', label: 'Monitoreo' },
  { id: 'skills', label: 'Skills' },
  { id: 'executions', label: 'Ejecuciones' },
  { id: 'usage', label: 'Consumo' },
];

type KindFilter = 'all' | 'mcp' | 'api' | 'plugin' | 'connected';

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'mcp', label: 'MCP' },
  { id: 'api', label: 'APIs' },
  { id: 'plugin', label: 'Plugins' },
  { id: 'connected', label: 'Con conexiones' },
];

const KIND_META: Record<string, { label: string; icon: React.ElementType }> = {
  mcp: { label: 'MCP', icon: Globe },
  api: { label: 'API', icon: Braces },
  plugin: { label: 'Plugin', icon: Plug },
  skill: { label: 'Skill', icon: KeyRound },
};

const EXEC_FILTERS = [
  { id: 'all', label: 'Todas' },
  { id: 'success', label: 'Exitosas' },
  { id: 'failed', label: 'Fallidas' },
] as const;

const EMPTY_FORM: ExtensionForm = {
  kind: 'mcp',
  namespace: '',
  name: '',
  description: '',
  allowedHosts: '',
  allowedRoleKeys: '',
  url: '',
  apiKeyHeader: 'X-API-Key',
};

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

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} d`;
  return new Date(iso).toLocaleDateString('es-MX');
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
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [extSearch, setExtSearch] = useState('');
  const [execFilter, setExecFilter] = useState<(typeof EXEC_FILTERS)[number]['id']>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<ExtensionForm>(EMPTY_FORM);

  // Real Composio catalog for the "Catálogo" tab
  const [composioApps, setComposioApps] = useState<ComposioAppItem[] | null>(null);
  const [composioConfigured, setComposioConfigured] = useState<boolean | null>(null);
  const [composioLoading, setComposioLoading] = useState(false);
  const [composioError, setComposioError] = useState<string | null>(null);
  const [addingToolkit, setAddingToolkit] = useState<string | null>(null);

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

  useEffect(() => {
    loadList();
  }, [loadList]);

  const loadComposioCatalog = useCallback(async () => {
    setComposioLoading(true);
    setComposioError(null);
    try {
      const data = await api<{
        configured: boolean;
        catalog: ComposioAppItem[];
        policies: Array<{ toolkitSlug: string; enabled: boolean }>;
      }>('/app/admin/extensions/api/composio');
      setComposioConfigured(data.configured);
      const statusBySlug = new Map(
        data.policies.map((p) => [
          p.toolkitSlug,
          p.enabled ? ('enabled' as const) : ('configured' as const),
        ])
      );
      setComposioApps(
        data.catalog.map((t) => ({ ...t, status: statusBySlug.get(t.slug) ?? null }))
      );
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : 'No se pudo cargar Composio');
    } finally {
      setComposioLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'catalog' && composioApps === null && !composioLoading) void loadComposioCatalog();
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
  }, [tab, composioApps, composioLoading, loadComposioCatalog]);

  const filteredExtensions = useMemo(() => {
    const q = extSearch.trim().toLowerCase();
    return extensions.filter((e) => {
      if (kindFilter === 'connected' && e.counts.connections === 0) return false;
      if (kindFilter !== 'all' && kindFilter !== 'connected' && e.kind !== kindFilter) return false;
      if (q && ![e.name, e.namespace, e.kind].some((s) => s.toLowerCase().includes(q)))
        return false;
      return true;
    });
  }, [extensions, kindFilter, extSearch]);

  const filteredExecutions = useMemo(
    () => executions.filter((x) => execFilter === 'all' || x.status === execFilter),
    [executions, execFilter]
  );

  /** Pre-fill the creation sheet when the user picks a curated catalog entry. */
  function handleCatalogConnect(entry: CuratedEntry) {
    setForm({
      kind: entry.kind === 'skill' ? 'plugin' : entry.kind,
      namespace: entry.id.replace(/[^a-z0-9_.-]/g, '.'),
      name: entry.name,
      description: entry.description,
      allowedHosts: entry.allowedHosts.join(', '),
      allowedRoleKeys: '',
      url: entry.kind === 'mcp' ? '' : `https://${entry.allowedHosts[0] ?? ''}`,
      apiKeyHeader: entry.authType === 'api_key' ? 'X-API-Key' : 'Authorization',
    });
    setTab('extensions');
    setCreateOpen(true);
  }

  /**
   * "Agregar" on a Composio app card: creates its governance policy (disabled
   * until the admin enables it and assigns roles in the Composio tab).
   */
  async function handleAddComposio(slug: string) {
    setAddingToolkit(slug);
    setError(null);
    try {
      await api('/app/admin/extensions/api/composio', {
        method: 'PUT',
        body: JSON.stringify({ toolkit: slug }),
      });
      setComposioApps((prev) =>
        (prev ?? []).map((a) => (a.slug === slug ? { ...a, status: 'configured' } : a))
      );
      setNotice('App agregada — habilítala y asigna roles en la pestaña Composio.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo agregar la app');
    } finally {
      setAddingToolkit(null);
    }
  }

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
      setForm(EMPTY_FORM);
      setCreateOpen(false);
      await loadList();
    }, 'Extensión creada en borrador — ábrela para revisar sus capacidades');
  }

  async function suspendExtension(id: string) {
    await run(async () => {
      await api(`/app/admin/extensions/api/extensions/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'suspended',
          reason: 'Suspensión inmediata desde el panel',
        }),
      });
      await loadList();
    }, 'Extensión suspendida');
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
        {tab === 'monitoring' && <MonitoringTab extensions={extensions} />}

        {tab === 'composio' && <ComposioAdminTab canManage={canManage} />}

        {tab === 'catalog' && (
          <>
            <div className="assistant-admin-muted" role="note">
              Las <strong>Apps</strong> son integraciones reales de Composio: «Agregar» crea su
              policy y se habilitan/asignan roles en la pestaña{' '}
              <button type="button" className="gui-btn" onClick={() => setTab('composio')}>
                Composio
              </button>
              — cada usuario conecta su propia cuenta. Plugins y Skills son templates que abren el
              formulario de creación; los MCP remotos por HTTPS van en «Extensiones → Nueva».
            </div>
            <CatalogGrid
              onConnect={handleCatalogConnect}
              connectedNamespaces={extensions.map((e) => e.namespace)}
              composioApps={composioApps ?? undefined}
              composioConfigured={composioConfigured ?? undefined}
              composioLoading={composioLoading}
              composioError={composioError}
              onAddComposio={(slug) => void handleAddComposio(slug)}
              onManageComposio={() => setTab('composio')}
              addingToolkit={addingToolkit}
            />
          </>
        )}

        {tab === 'extensions' && (
          <div className="assistant-admin-section">
            <div className="ext-toolbar">
              <div className="ext-chips" role="group" aria-label="Filtrar por tipo">
                {KIND_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`ext-chip ${kindFilter === f.id ? 'active' : ''}`}
                    onClick={() => setKindFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="ext-toolbar-right">
                <div className="assistant-admin-search">
                  <Search size={14} />
                  <input
                    value={extSearch}
                    onChange={(e) => setExtSearch(e.target.value)}
                    placeholder="Buscar extensión…"
                    aria-label="Buscar extensión"
                  />
                </div>
                {canManage && (
                  <button
                    type="button"
                    className="assistant-admin-save-btn"
                    onClick={() => {
                      setForm(EMPTY_FORM);
                      setCreateOpen(true);
                    }}
                  >
                    <Plus size={16} /> Nueva extensión
                  </button>
                )}
              </div>
            </div>

            <div className="assistant-admin-table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Tipo</th>
                    <th>Estado</th>
                    <th>Capacidades</th>
                    <th>Conexiones</th>
                    <th>Ejecuciones</th>
                    <th>Última prueba</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExtensions.map((e) => {
                    const meta = KIND_META[e.kind] ?? { label: e.kind, icon: Plug };
                    const Icon = meta.icon;
                    return (
                      <tr
                        key={e.id}
                        className={`assistant-admin-row-clickable ${selectedId === e.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(e.id)}
                      >
                        <td>
                          {e.name}
                          <div className="assistant-admin-list-meta">{e.namespace}</div>
                        </td>
                        <td>
                          <span className="ext-kind-tag">
                            <Icon size={12} /> {meta.label}
                          </span>
                        </td>
                        <td>
                          <span className={badgeClass(e.status)}>{statusLabel(e.status)}</span>
                        </td>
                        <td>{e.counts.capabilities}</td>
                        <td>{e.counts.connections}</td>
                        <td>{e.counts.executions}</td>
                        <td className="assistant-admin-muted">
                          {e.versions.find((v) => v.lastTestedAt)?.lastTestedAt
                            ? relTime(e.versions.find((v) => v.lastTestedAt)!.lastTestedAt!)
                            : '—'}
                        </td>
                        <td>
                          {canManage && (e.status === 'enabled' || e.status === 'approved') && (
                            <button
                              type="button"
                              className="assistant-admin-test-btn danger"
                              disabled={busy}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void suspendExtension(e.id);
                              }}
                            >
                              Suspender
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredExtensions.length === 0 && (
                    <tr>
                      <td colSpan={8} className="assistant-admin-muted">
                        {extensions.length === 0
                          ? 'Sin extensiones aún — crea una con «Nueva extensión» o agrega una app del catálogo.'
                          : 'Ninguna extensión coincide con el filtro.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'executions' && (
          <div className="assistant-admin-section">
            <div className="ext-toolbar">
              <h3 className="assistant-admin-section-title">Ejecuciones externas (auditoría)</h3>
              <div className="ext-chips" role="group" aria-label="Filtrar por estado">
                {EXEC_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`ext-chip ${execFilter === f.id ? 'active' : ''}`}
                    onClick={() => setExecFilter(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="assistant-admin-table-wrap">
              <table className="assistant-admin-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Herramienta</th>
                    <th>Extensión</th>
                    <th>Estado</th>
                    <th>ms</th>
                    <th>Bytes</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExecutions.map((x) => (
                    <tr key={x.id}>
                      <td title={new Date(x.createdAt).toLocaleString('es-MX')}>
                        {relTime(x.createdAt)}
                      </td>
                      <td>{x.toolName}</td>
                      <td className="assistant-admin-muted">
                        {extensions.find((e) => e.id === x.extensionId)?.name ?? '—'}
                      </td>
                      <td>
                        <span className={badgeClass(x.status)}>{statusLabel(x.status)}</span>
                      </td>
                      <td>{x.durationMs}</td>
                      <td>{x.requestBytes + x.responseBytes}</td>
                      <td className="assistant-admin-msg-preview">
                        {x.errorMessage ?? x.errorCode ?? ''}
                      </td>
                    </tr>
                  ))}
                  {filteredExecutions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="assistant-admin-muted">
                        {execFilter === 'all'
                          ? 'Sin ejecuciones'
                          : 'Sin ejecuciones con ese estado'}
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
                      <td>{s.scope === 'team' ? 'Equipo' : 'Personal'}</td>
                      <td>
                        <span className={badgeClass(s.status)}>{statusLabel(s.status)}</span>
                      </td>
                      <td>v{s.version}</td>
                      <td>
                        {canPublishSkills && s.scope === 'team' && s.status !== 'published' && (
                          <button
                            type="button"
                            className="assistant-admin-test-btn"
                            disabled={busy}
                            onClick={() => void setSkillStatus(s.id, 'published')}
                          >
                            Publicar
                          </button>
                        )}
                        {canPublishSkills && s.scope === 'team' && s.status === 'published' && (
                          <button
                            type="button"
                            className="assistant-admin-test-btn"
                            disabled={busy}
                            onClick={() => void setSkillStatus(s.id, 'suspended')}
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
      </div>

      <NewExtensionSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        form={form}
        setForm={setForm}
        busy={busy}
        onCreate={(kind) => void createExtension(kind)}
      />
      <ExtensionDetailDrawer
        extensionId={selectedId}
        canManage={canManage}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onChanged={loadList}
      />
    </div>
  );
}

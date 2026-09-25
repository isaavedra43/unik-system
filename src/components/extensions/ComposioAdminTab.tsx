'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Plug, Search } from 'lucide-react';

interface Policy {
  toolkitSlug: string;
  enabled: boolean;
  allowedRoleKeys: string[];
  effectOverrides: Record<string, string>;
  disabledTools: string[];
}
interface Role {
  key: string;
  name: string;
}
interface CatalogItem {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  noAuth: boolean;
}
interface ToolRow {
  slug: string;
  description: string;
  inferredEffect: string;
  effect: string;
  overridden: boolean;
  disabled: boolean;
}

const EFFECT_LABELS: Record<string, string> = {
  read: 'Lectura (automática)',
  draft: 'Borrador (automático)',
  internal_task: 'Tarea interna (automática)',
  external_send: 'Envío externo (aprobación)',
  business_write: 'Escritura (aprobación)',
  destructive: 'Destructiva (aprobación)',
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Error de red');
  return data as T;
}

/**
 * Admin → Extensiones → Composio. Governance only: which toolkits the assistant
 * may use, for which roles, and how each tool's effect is classified. Accounts
 * and tokens live in Composio; nothing secret is shown or stored here.
 */
export function ComposioAdminTab({ canManage }: { canManage: boolean }) {
  const [state, setState] = useState<{
    configured: boolean;
    policies: Policy[];
    roles: Role[];
    catalog: CatalogItem[];
  } | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, ToolRow[] | 'loading'>>({});

  const load = useCallback(async (q?: string) => {
    try {
      setError(null);
      setState(
        await api(
          `/app/admin/extensions/api/composio${q ? `?search=${encodeURIComponent(q)}` : ''}`
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(toolkit: string, patch: Record<string, unknown>) {
    setBusy(toolkit);
    setError(null);
    try {
      await api('/app/admin/extensions/api/composio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit, ...patch }),
      });
      await load(search || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(null);
    }
  }

  async function toggleTools(slug: string) {
    if (open === slug) return setOpen(null);
    setOpen(slug);
    if (tools[slug]) return;
    setTools((t) => ({ ...t, [slug]: 'loading' }));
    try {
      const data = await api<{ tools: ToolRow[] }>(
        `/app/admin/extensions/api/composio/tools?toolkit=${encodeURIComponent(slug)}`
      );
      setTools((t) => ({ ...t, [slug]: data.tools }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron listar las herramientas');
      setTools((t) => {
        const { [slug]: _drop, ...rest } = t;
        void _drop;
        return rest;
      });
    }
  }

  if (!state) return <div className="assistant-admin-loading">{error ?? 'Cargando…'}</div>;
  const policyBySlug = new Map(state.policies.map((p) => [p.toolkitSlug, p] as const));

  return (
    <div className="assistant-admin-section">
      <h3 className="assistant-admin-section-title">Composio · apps externas del asistente</h3>
      {!state.configured ? (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={16} /> Falta la variable <code>COMPOSIO_API_KEY</code> en el servidor
          (Railway → Variables). Sin ella el asistente no ofrece estas herramientas.
        </div>
      ) : (
        <p className="assistant-admin-muted">
          Cada persona conecta su propia cuenta desde el chat o desde «Extensiones y skills». Aquí
          decides qué apps pueden usarse y por qué roles. Enviar, crear, modificar o borrar siempre
          pide aprobación.
        </p>
      )}
      {error && (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <h4 className="assistant-admin-section-title">Apps configuradas</h4>
      {state.policies.length === 0 ? (
        <p className="assistant-admin-muted">
          Ninguna todavía. Habilita una del catálogo de abajo.
        </p>
      ) : (
        <div className="assistant-admin-table-wrap">
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Estado</th>
                <th>Roles autorizados</th>
                <th>Herramientas</th>
              </tr>
            </thead>
            <tbody>
              {state.policies.map((p) => {
                const rows = tools[p.toolkitSlug];
                return (
                  <React.Fragment key={p.toolkitSlug}>
                    <tr>
                      <td>
                        <strong>{p.toolkitSlug}</strong>
                      </td>
                      <td>
                        <label className="gui-field">
                          <input
                            type="checkbox"
                            checked={p.enabled}
                            disabled={!canManage || busy === p.toolkitSlug}
                            onChange={(e) =>
                              void save(p.toolkitSlug, { enabled: e.target.checked })
                            }
                          />
                          <span>{p.enabled ? 'Habilitada' : 'Deshabilitada'}</span>
                        </label>
                      </td>
                      <td>
                        <div className="gui-fields">
                          {state.roles.map((r) => (
                            <label key={r.key} className="gui-field">
                              <input
                                type="checkbox"
                                checked={p.allowedRoleKeys.includes(r.key)}
                                disabled={!canManage || busy === p.toolkitSlug}
                                onChange={(e) =>
                                  void save(p.toolkitSlug, {
                                    allowedRoleKeys: e.target.checked
                                      ? [...p.allowedRoleKeys, r.key]
                                      : p.allowedRoleKeys.filter((k) => k !== r.key),
                                  })
                                }
                              />
                              <span>{r.name}</span>
                            </label>
                          ))}
                        </div>
                        {p.allowedRoleKeys.length === 0 && (
                          <span className="assistant-admin-muted">Solo super administradores</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="gui-btn"
                          onClick={() => void toggleTools(p.toolkitSlug)}
                          aria-expanded={open === p.toolkitSlug}
                        >
                          {open === p.toolkitSlug ? (
                            <ChevronDown size={12} />
                          ) : (
                            <ChevronRight size={12} />
                          )}{' '}
                          Revisar
                        </button>
                      </td>
                    </tr>
                    {open === p.toolkitSlug && (
                      <tr>
                        <td colSpan={4}>
                          {rows === 'loading' || !rows ? (
                            <Loader2 size={14} className="copilot-spin" />
                          ) : (
                            <table className="assistant-admin-table">
                              <thead>
                                <tr>
                                  <th>Herramienta</th>
                                  <th>Efecto (UNIK)</th>
                                  <th>Ofrecer</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map((t) => (
                                  <tr key={t.slug}>
                                    <td>
                                      <code>{t.slug}</code>
                                      <div className="assistant-admin-muted">{t.description}</div>
                                    </td>
                                    <td>
                                      <select
                                        className="assistant-admin-select"
                                        value={p.effectOverrides[t.slug] ?? t.inferredEffect}
                                        disabled={!canManage || busy === p.toolkitSlug}
                                        onChange={(e) => {
                                          const next = { ...p.effectOverrides };
                                          if (e.target.value === t.inferredEffect)
                                            delete next[t.slug];
                                          else next[t.slug] = e.target.value;
                                          void save(p.toolkitSlug, { effectOverrides: next });
                                        }}
                                      >
                                        {Object.entries(EFFECT_LABELS).map(([k, label]) => (
                                          <option key={k} value={k}>
                                            {label}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                    <td>
                                      <input
                                        type="checkbox"
                                        aria-label={`Ofrecer ${t.slug}`}
                                        checked={!p.disabledTools.includes(t.slug)}
                                        disabled={!canManage || busy === p.toolkitSlug}
                                        onChange={(e) =>
                                          void save(p.toolkitSlug, {
                                            disabledTools: e.target.checked
                                              ? p.disabledTools.filter((x) => x !== t.slug)
                                              : [...p.disabledTools, t.slug],
                                          })
                                        }
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {state.configured && (
        <>
          <h4 className="assistant-admin-section-title">Catálogo de Composio</h4>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load(search.trim() || undefined);
            }}
            className="gui-fields"
          >
            <label className="gui-field">
              <Search size={14} aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar app: gmail, slack, github…"
                aria-label="Buscar en el catálogo de Composio"
              />
            </label>
            <button type="submit" className="gui-btn">
              Buscar
            </button>
          </form>
          <div className="assistant-admin-table-wrap">
            <table className="assistant-admin-table">
              <tbody>
                {state.catalog.slice(0, 40).map((c) => {
                  const configured = policyBySlug.get(c.slug);
                  return (
                    <tr key={c.slug}>
                      <td>
                        <strong>{c.name}</strong>{' '}
                        <span className="assistant-admin-muted">{c.slug}</span>
                        <div className="assistant-admin-muted">{c.description}</div>
                      </td>
                      <td>{c.categories.slice(0, 2).join(' · ')}</td>
                      <td>
                        {configured ? (
                          <span
                            className={`assistant-admin-badge ${configured.enabled ? 'assistant-admin-badge-success' : ''}`}
                          >
                            {configured.enabled ? 'Habilitada' : 'Configurada'}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="gui-btn gui-btn-primary"
                            disabled={!canManage || busy === c.slug}
                            onClick={() => void save(c.slug, { enabled: false })}
                          >
                            <Plug size={12} /> Agregar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {state.catalog.length > 40 && (
              <p className="assistant-admin-muted" role="note">
                Mostrando 40 de {state.catalog.length} apps — usa la búsqueda para filtrar, o
                agrégalas desde la pestaña Catálogo.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Link2, Play, Plus, Trash2, Unlink } from 'lucide-react';

/**
 * User-facing extensions: approved catalog, personal connections and
 * personal skills (recipes) built on already-authorized tools.
 */

interface CatalogExtension {
  id: string;
  namespace: string;
  kind: string;
  name: string;
  description: string | null;
  supportsPersonalConnection: boolean;
  oauthConfigured: boolean;
  capabilities: Array<{
    id: string;
    name: string;
    description: string;
    effect: string;
    connectionScope: string;
  }>;
  personalConnections: Array<{
    id: string;
    name: string;
    status: string;
    authType: string;
    expiresAt: string | null;
  }>;
}

interface Skill {
  id: string;
  key: string;
  name: string;
  purpose: string;
  scope: string;
  status: string;
  version: number;
  definition: {
    inputs: Array<{ name: string; label: string; type: string; required: boolean }>;
    allowedTools: string[];
    steps: unknown[];
  };
}

const EXAMPLE_SKILL = JSON.stringify(
  {
    inputs: [{ name: 'cliente', label: 'Cliente', type: 'string', required: true }],
    instructions: 'Revisa las ventas del cliente y prepara un resumen.',
    references: [],
    allowedTools: ['querySalesOrders', 'generateTable'],
    steps: [
      {
        id: 'ventas',
        type: 'tool',
        tool: 'querySalesOrders',
        args: { customer: '{{inputs.cliente}}', dateRange: 'this_year' },
      },
      {
        id: 'hay',
        type: 'check',
        condition: { path: 'steps.ventas.result.total', op: 'gt', value: 0 },
        message: 'El cliente no tiene ventas este año',
        dependsOn: ['ventas'],
      },
      {
        id: 'tabla',
        type: 'tool',
        tool: 'generateTable',
        args: { title: 'Ventas de {{inputs.cliente}}' },
        dependsOn: ['hay'],
      },
    ],
    completion: { conditions: [], summaryTemplate: 'Resumen listo para {{inputs.cliente}}' },
    limits: { maxToolCalls: 10, maxDurationMs: 120000 },
  },
  null,
  2
);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export function ExtensionsUserPanel({
  canConnect,
  oauthOutcome,
}: {
  canConnect: boolean;
  oauthOutcome: string | null;
}) {
  const [extensions, setExtensions] = useState<CatalogExtension[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    oauthOutcome === 'connected'
      ? 'Cuenta conectada correctamente'
      : oauthOutcome === 'denied'
        ? 'La autorización fue cancelada'
        : oauthOutcome === 'failed'
          ? 'No se pudo completar la conexión'
          : null
  );
  const [busy, setBusy] = useState(false);
  const [apiKeyFor, setApiKeyFor] = useState<{ extensionId: string; value: string } | null>(null);
  const [skillForm, setSkillForm] = useState({
    key: '',
    name: '',
    purpose: '',
    definition: EXAMPLE_SKILL,
  });
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ extensions: CatalogExtension[]; skills: Skill[] }>(
        '/app/assistant/api/extensions/catalog'
      );
      setExtensions(data.extensions);
      setSkills(data.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<void>, ok?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  async function startOAuth(extensionId: string) {
    await run(async () => {
      const r = await api<{ url: string }>(
        `/app/assistant/api/extensions/${extensionId}/oauth/start`,
        { method: 'POST', body: JSON.stringify({ scopeType: 'personal' }) }
      );
      window.location.href = r.url;
    });
  }

  async function saveApiKey() {
    if (!apiKeyFor) return;
    const { extensionId, value } = apiKeyFor;
    await run(async () => {
      await api(`/app/assistant/api/extensions/${extensionId}/connections`, {
        method: 'POST',
        body: JSON.stringify({
          scopeType: 'personal',
          authType: 'api_key',
          name: 'Mi cuenta',
          secret: { apiKey: value },
        }),
      });
      setApiKeyFor(null);
    }, 'Cuenta conectada (la clave no se vuelve a mostrar)');
  }

  async function disconnect(extensionId: string, connectionId: string) {
    await run(async () => {
      await api(`/app/assistant/api/extensions/${extensionId}/connections/${connectionId}`, {
        method: 'DELETE',
      });
    }, 'Cuenta desconectada');
  }

  async function createSkill() {
    await run(async () => {
      const definition = JSON.parse(skillForm.definition);
      await api('/app/assistant/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          key: skillForm.key,
          name: skillForm.name,
          purpose: skillForm.purpose,
          scope: 'personal',
          definition,
        }),
      });
      setSkillForm({ key: '', name: '', purpose: '', definition: EXAMPLE_SKILL });
    }, 'Skill personal guardada');
  }

  async function deleteSkill(id: string) {
    await run(async () => {
      await api(`/app/assistant/api/skills/${id}`, { method: 'DELETE' });
    }, 'Skill eliminada');
  }

  async function runSkill(skill: Skill) {
    await run(async () => {
      const inputs: Record<string, unknown> = {};
      for (const input of skill.definition.inputs) {
        const raw = runInputs[`${skill.id}:${input.name}`] ?? '';
        if (raw === '') continue;
        inputs[input.name] =
          input.type === 'number'
            ? Number(raw)
            : input.type === 'boolean'
              ? raw === 'true'
              : input.type === 'json'
                ? JSON.parse(raw)
                : raw;
      }
      const r = await api(`/app/assistant/api/skills/${skill.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ inputs }),
      });
      setRunResult(r);
    });
  }

  if (loading) return <div className="assistant-admin-loading">Cargando…</div>;

  return (
    <div className="assistant-admin-panel">
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

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Catálogo aprobado</h3>
        {extensions.length === 0 && (
          <div className="assistant-admin-empty">
            Todavía no hay extensiones habilitadas para tu equipo. Pide a un administrador que
            apruebe una o propón una nueva.
          </div>
        )}
        <div className="assistant-admin-list">
          {extensions.map((e) => (
            <div
              key={e.id}
              className="assistant-admin-list-item"
              style={{ alignItems: 'flex-start', flexDirection: 'column' }}
            >
              <div className="assistant-admin-list-name">
                {e.name} <span className="assistant-admin-badge">{e.kind}</span>
              </div>
              <div className="assistant-admin-list-meta">{e.description ?? e.namespace}</div>
              <div className="assistant-admin-list-meta">
                Capacidades:{' '}
                {e.capabilities.map((c) => `${c.name} (${c.effect})`).join(', ') || '—'}
              </div>
              {e.supportsPersonalConnection && (
                <div className="assistant-admin-filters">
                  {e.personalConnections.map((c) => (
                    <span
                      key={c.id}
                      className="assistant-admin-badge assistant-admin-badge-success"
                    >
                      {c.name} · {c.status}
                      {canConnect && (
                        <button
                          type="button"
                          className="assistant-admin-test-btn"
                          disabled={busy}
                          onClick={() => disconnect(e.id, c.id)}
                          aria-label="Desconectar"
                        >
                          <Unlink size={12} />
                        </button>
                      )}
                    </span>
                  ))}
                  {canConnect && e.oauthConfigured && (
                    <button
                      type="button"
                      className="assistant-admin-test-btn"
                      disabled={busy}
                      onClick={() => startOAuth(e.id)}
                    >
                      <Link2 size={14} /> Conectar mi cuenta
                    </button>
                  )}
                  {canConnect &&
                    !e.oauthConfigured &&
                    (apiKeyFor?.extensionId === e.id ? (
                      <>
                        <input
                          type="password"
                          autoComplete="off"
                          className="assistant-admin-filter-input"
                          placeholder="API key personal"
                          value={apiKeyFor.value}
                          onChange={(ev) =>
                            setApiKeyFor({ extensionId: e.id, value: ev.target.value })
                          }
                          aria-label="API key"
                        />
                        <button
                          type="button"
                          className="assistant-admin-save-btn"
                          disabled={busy || !apiKeyFor.value}
                          onClick={saveApiKey}
                        >
                          Guardar
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        disabled={busy}
                        onClick={() => setApiKeyFor({ extensionId: e.id, value: '' })}
                      >
                        <Link2 size={14} /> Conectar con API key
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="assistant-admin-section">
        <h3 className="assistant-admin-section-title">Mis skills (recetas)</h3>
        <p className="assistant-admin-muted">
          Una skill personal se ejecuta con herramientas que ya tienes autorizadas. Compartirla como
          capacidad de equipo requiere publicación administrativa.
        </p>
        <div className="assistant-admin-list">
          {skills.map((s) => (
            <div
              key={s.id}
              className="assistant-admin-list-item"
              style={{ alignItems: 'flex-start', flexDirection: 'column' }}
            >
              <div className="assistant-admin-list-name">
                {s.name} <span className="assistant-admin-badge">{s.scope}</span>{' '}
                <span className="assistant-admin-badge">{s.status}</span> v{s.version}
              </div>
              <div className="assistant-admin-list-meta">
                {s.purpose} · herramientas: {s.definition.allowedTools.join(', ')}
              </div>
              <div className="assistant-admin-filters">
                {s.definition.inputs.map((i) => (
                  <input
                    key={i.name}
                    className="assistant-admin-filter-input"
                    placeholder={`${i.label || i.name}${i.required ? ' *' : ''}`}
                    value={runInputs[`${s.id}:${i.name}`] ?? ''}
                    onChange={(e) =>
                      setRunInputs({ ...runInputs, [`${s.id}:${i.name}`]: e.target.value })
                    }
                    aria-label={i.label || i.name}
                  />
                ))}
                <button
                  type="button"
                  className="assistant-admin-test-btn"
                  disabled={busy || s.status === 'suspended'}
                  onClick={() => runSkill(s)}
                >
                  <Play size={14} /> Ejecutar
                </button>
                {s.scope === 'personal' && (
                  <button
                    type="button"
                    className="assistant-admin-test-btn"
                    disabled={busy}
                    onClick={() => deleteSkill(s.id)}
                    aria-label="Eliminar"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {skills.length === 0 && (
            <div className="assistant-admin-empty">Aún no tienes skills.</div>
          )}
        </div>
        {runResult !== null && (
          <pre className="assistant-admin-test-result">{JSON.stringify(runResult, null, 2)}</pre>
        )}

        <div className="assistant-admin-config-section">
          <h4>
            <Plus size={14} /> Nueva skill personal
          </h4>
          <div className="assistant-admin-config-grid">
            <div className="assistant-admin-config-field">
              <label htmlFor="sk-key">Clave</label>
              <input
                id="sk-key"
                value={skillForm.key}
                onChange={(e) => setSkillForm({ ...skillForm, key: e.target.value })}
                placeholder="resumen-cliente"
              />
            </div>
            <div className="assistant-admin-config-field">
              <label htmlFor="sk-name">Nombre</label>
              <input
                id="sk-name"
                value={skillForm.name}
                onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })}
              />
            </div>
            <div className="assistant-admin-config-field">
              <label htmlFor="sk-purpose">Propósito</label>
              <input
                id="sk-purpose"
                value={skillForm.purpose}
                onChange={(e) => setSkillForm({ ...skillForm, purpose: e.target.value })}
              />
            </div>
          </div>
          <label htmlFor="sk-def" className="assistant-admin-config-hint">
            Definición (JSON declarativo: inputs, instrucciones, referencias, herramientas
            admitidas, pasos, condiciones de finalización, límites)
          </label>
          <textarea
            id="sk-def"
            className="assistant-admin-filter-input"
            rows={12}
            value={skillForm.definition}
            onChange={(e) => setSkillForm({ ...skillForm, definition: e.target.value })}
          />
          <button
            type="button"
            className="assistant-admin-save-btn"
            disabled={busy || !skillForm.key || !skillForm.name || !skillForm.purpose}
            onClick={createSkill}
          >
            Guardar skill
          </button>
        </div>
      </div>
    </div>
  );
}

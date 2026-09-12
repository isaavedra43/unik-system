'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Drawer } from '@/components/ui/composite';

/**
 * Personalization (mode, tone, language, depth, format, instructions) and
 * personal memory (visible, editable, deletable; pending items proposed by
 * the assistant need explicit confirmation).
 */

interface Preferences {
  mode: 'paused' | 'on_request' | 'autonomous_verified';
  tone: 'profesional' | 'cercano' | 'directo';
  language: 'es' | 'en';
  depth: 'breve' | 'normal' | 'detallado';
  format: 'markdown' | 'texto' | 'tablas';
  customInstructions: string | null;
  memoryEnabled: boolean;
}

interface Memory {
  id: string;
  content: string;
  source: string;
  status: string;
  tags: string[];
  createdAt: string;
}

const MODES: Array<{ value: Preferences['mode']; label: string; hint: string }> = [
  {
    value: 'paused',
    label: 'Pausada',
    hint: 'Responde y redacta, sin ejecutar acciones con efectos.',
  },
  {
    value: 'on_request',
    label: 'A petición',
    hint: 'Consulta lo que pidas; propone acciones y espera tu aprobación.',
  },
  {
    value: 'autonomous_verified',
    label: 'Autónoma con verificación',
    hint: 'Encadena consultas y verifica; las acciones siguen requiriendo tu aprobación.',
  },
];

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

export function AssistantPreferencesPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newMemory, setNewMemory] = useState('');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, m] = await Promise.all([
        api<{ preferences: Preferences }>('/app/assistant/api/preferences'),
        api<{ memories: Memory[] }>('/app/assistant/api/memory'),
      ]);
      setPrefs(p.preferences);
      setMemories(m.memories);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function savePrefs(patch: Partial<Preferences>) {
    if (!prefs) return;
    setError(null);
    try {
      const r = await api<{ preferences: Preferences }>('/app/assistant/api/preferences', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setPrefs(r.preferences);
      setNotice('Preferencias guardadas');
      setTimeout(() => setNotice(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function addMemory() {
    if (!newMemory.trim()) return;
    try {
      await api('/app/assistant/api/memory', {
        method: 'POST',
        body: JSON.stringify({ content: newMemory }),
      });
      setNewMemory('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      await api(`/app/assistant/api/memory/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: editing.content }),
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function remove(id: string) {
    try {
      await api(`/app/assistant/api/memory/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function decide(id: string, accept: boolean) {
    try {
      await api(`/app/assistant/api/memory/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ accept }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  const pending = memories.filter((m) => m.status === 'pending');
  const active = memories.filter((m) => m.status === 'active');

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Preferencias y memoria"
      subtitle="Cómo debe comportarse el asistente contigo"
      size="lg"
    >
      {loading && <div className="assistant-admin-loading">Cargando…</div>}
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
      {prefs && (
        <>
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Modo de trabajo</h3>
            <div className="assistant-admin-list">
              {MODES.map((m) => (
                <label key={m.value} className="assistant-admin-list-item">
                  <input
                    type="radio"
                    name="assistant-mode"
                    checked={prefs.mode === m.value}
                    onChange={() => savePrefs({ mode: m.value })}
                  />
                  <span className="assistant-admin-list-name">{m.label}</span>
                  <span className="assistant-admin-list-meta">{m.hint}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Personalización</h3>
            <div className="assistant-admin-config-grid">
              <div className="assistant-admin-config-field">
                <label htmlFor="pref-tone">Tono</label>
                <select
                  id="pref-tone"
                  className="assistant-admin-select"
                  value={prefs.tone}
                  onChange={(e) => savePrefs({ tone: e.target.value as Preferences['tone'] })}
                >
                  <option value="profesional">Profesional</option>
                  <option value="cercano">Cercano</option>
                  <option value="directo">Directo</option>
                </select>
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="pref-lang">Idioma</label>
                <select
                  id="pref-lang"
                  className="assistant-admin-select"
                  value={prefs.language}
                  onChange={(e) =>
                    savePrefs({ language: e.target.value as Preferences['language'] })
                  }
                >
                  <option value="es">Español</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="pref-depth">Profundidad</label>
                <select
                  id="pref-depth"
                  className="assistant-admin-select"
                  value={prefs.depth}
                  onChange={(e) => savePrefs({ depth: e.target.value as Preferences['depth'] })}
                >
                  <option value="breve">Breve</option>
                  <option value="normal">Normal</option>
                  <option value="detallado">Detallado</option>
                </select>
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="pref-format">Formato</label>
                <select
                  id="pref-format"
                  className="assistant-admin-select"
                  value={prefs.format}
                  onChange={(e) => savePrefs({ format: e.target.value as Preferences['format'] })}
                >
                  <option value="markdown">Markdown</option>
                  <option value="texto">Texto corrido</option>
                  <option value="tablas">Tablas</option>
                </select>
              </div>
              <div className="assistant-admin-config-field">
                <label htmlFor="pref-memory">Usar mi memoria personal</label>
                <input
                  id="pref-memory"
                  type="checkbox"
                  checked={prefs.memoryEnabled}
                  onChange={(e) => savePrefs({ memoryEnabled: e.target.checked })}
                />
              </div>
            </div>
            <div className="assistant-admin-config-field">
              <label htmlFor="pref-instr">Instrucciones personales</label>
              <textarea
                id="pref-instr"
                className="assistant-admin-filter-input"
                rows={3}
                defaultValue={prefs.customInstructions ?? ''}
                onBlur={(e) => savePrefs({ customInstructions: e.target.value || null })}
                placeholder="Ej. Cuando pida reportes, incluye siempre el vendedor."
              />
            </div>
          </div>
          <div className="assistant-admin-section">
            <h3 className="assistant-admin-section-title">Memoria personal</h3>
            <p className="assistant-admin-muted">
              Lo que el asistente recuerda de ti. Puedes editar o borrar cualquier recuerdo. Lo que
              el asistente proponga queda pendiente hasta que lo confirmes.
            </p>
            {pending.length > 0 && (
              <div className="assistant-admin-list">
                {pending.map((m) => (
                  <div key={m.id} className="assistant-admin-list-item">
                    <span className="assistant-admin-badge">pendiente · {m.source}</span>
                    <span className="assistant-admin-list-name">{m.content}</span>
                    <button
                      type="button"
                      className="assistant-admin-test-btn"
                      onClick={() => decide(m.id, true)}
                      aria-label="Confirmar"
                    >
                      <Check size={14} /> Confirmar
                    </button>
                    <button
                      type="button"
                      className="assistant-admin-test-btn"
                      onClick={() => decide(m.id, false)}
                      aria-label="Descartar"
                    >
                      <X size={14} /> Descartar
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="assistant-admin-list">
              {active.map((m) => (
                <div key={m.id} className="assistant-admin-list-item">
                  {editing?.id === m.id ? (
                    <>
                      <input
                        className="assistant-admin-filter-input"
                        value={editing.content}
                        onChange={(e) => setEditing({ id: m.id, content: e.target.value })}
                        aria-label="Editar recuerdo"
                      />
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        onClick={saveEdit}
                        aria-label="Guardar"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        onClick={() => setEditing(null)}
                        aria-label="Cancelar"
                      >
                        <X size={14} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="assistant-admin-list-name">{m.content}</span>
                      <span className="assistant-admin-list-meta">
                        {m.source} · {new Date(m.createdAt).toLocaleDateString('es-MX')}
                      </span>
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        onClick={() => setEditing({ id: m.id, content: m.content })}
                        aria-label="Editar"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="assistant-admin-test-btn"
                        onClick={() => remove(m.id)}
                        aria-label="Eliminar"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {active.length === 0 && pending.length === 0 && (
                <div className="assistant-admin-empty">Sin recuerdos todavía.</div>
              )}
            </div>
            <div className="assistant-admin-filters">
              <input
                className="assistant-admin-filter-input"
                placeholder="Nuevo recuerdo, ej. Prefiero reportes en Excel"
                value={newMemory}
                onChange={(e) => setNewMemory(e.target.value)}
                aria-label="Nuevo recuerdo"
              />
              <button
                type="button"
                className="assistant-admin-save-btn"
                onClick={addMemory}
                disabled={!newMemory.trim()}
              >
                <Plus size={14} /> Guardar
              </button>
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}

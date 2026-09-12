'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, RotateCcw, Save } from 'lucide-react';
import type { VoiceAgentSettings } from '@/modules/voice/voice-agent-settings';

/**
 * Deep configuration of the voice agent: persona, model, voice, speaking
 * style, allowed information, public facts, forbidden topics and the prompt
 * itself. Saved settings apply to the next call (no redeploy). The honesty
 * rule is shown but not editable.
 */

interface Catalog {
  id: string;
  label: string;
  hint?: string;
}

interface Payload {
  settings: VoiceAgentSettings;
  preview: { instructions: string; greeting: string; tools: string[] };
  catalogs: {
    models: Catalog[];
    voices: Catalog[];
    sttModels: Catalog[];
    domains: Array<{ key: string; label: string; hint: string }>;
  };
}

const API = '/app/admin/voice/api/agent';

export function VoiceAgentSettingsPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [form, setForm] = useState<VoiceAgentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(API);
      if (!res.ok) {
        setError('No se pudo cargar la configuración del agente');
        return;
      }
      const payload = (await res.json()) as Payload;
      setData(payload);
      setForm((prev) => prev ?? payload.settings);
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = (await res.json().catch(() => ({}))) as Payload & { error?: string };
      if (!res.ok) {
        setError(payload.error ?? 'No se pudo guardar');
        return;
      }
      setData(payload);
      setForm(payload.settings);
      setNotice('Configuración del agente guardada. Aplica desde la siguiente llamada.');
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <div className="assistant-admin-loading">Cargando…</div>;
  if (!data || !form) return <div className="assistant-admin-error">{error ?? 'Sin datos'}</div>;

  const set = <K extends keyof VoiceAgentSettings>(key: K, value: VoiceAgentSettings[K]) =>
    setForm({ ...form, [key]: value });
  const toggleDomain = (key: string, on: boolean) =>
    set(
      'allowedDomains',
      on
        ? [...new Set([...form.allowedDomains, key])]
        : form.allowedDomains.filter((d) => d !== key)
    );
  const modelHint = data.catalogs.models.find((m) => m.id === form.model)?.hint;
  const voiceHint = data.catalogs.voices.find((v) => v.id === form.voice)?.hint;

  return (
    <div className="assistant-admin-section" style={{ display: 'grid', gap: '1.5rem' }}>
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

      <section>
        <h3 className="assistant-admin-section-title">Identidad</h3>
        <div className="assistant-admin-config-grid">
          <div className="assistant-admin-config-field">
            <label htmlFor="va-persona">Nombre con el que se presenta</label>
            <input
              id="va-persona"
              value={form.personaName}
              maxLength={40}
              onChange={(e) => set('personaName', e.target.value)}
            />
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-company">Nombre de la empresa</label>
            <input
              id="va-company"
              value={form.companyName}
              maxLength={80}
              onChange={(e) => set('companyName', e.target.value)}
            />
          </div>
          <div className="assistant-admin-config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="va-desc">A qué se dedica la empresa</label>
            <textarea
              id="va-desc"
              rows={2}
              value={form.companyDescription}
              maxLength={600}
              onChange={(e) => set('companyDescription', e.target.value)}
              placeholder="Ej. Distribuidora de material eléctrico para industria y construcción en el Bajío."
            />
            <span className="assistant-admin-config-hint">
              Ayuda a la asistente a mantenerse en tema y a entender a los clientes.
            </span>
          </div>
          <div className="assistant-admin-config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="va-greeting">Saludo inicial</label>
            <input
              id="va-greeting"
              value={form.greetingTemplate}
              maxLength={300}
              onChange={(e) => set('greetingTemplate', e.target.value)}
            />
            <span className="assistant-admin-config-hint">
              Variables: <code>{'{empresa}'}</code>, <code>{'{asistente}'}</code>,{' '}
              <code>{'{nombre}'}</code> (nombre del cliente si el número está registrado). Vista
              previa: “{data.preview.greeting}”
            </span>
          </div>
        </div>
      </section>

      <section>
        <h3 className="assistant-admin-section-title">Modelo y voz</h3>
        <div className="assistant-admin-config-grid">
          <div className="assistant-admin-config-field">
            <label htmlFor="va-model">Modelo</label>
            <select id="va-model" value={form.model} onChange={(e) => set('model', e.target.value)}>
              {data.catalogs.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {modelHint && <span className="assistant-admin-config-hint">{modelHint}</span>}
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-voice">Voz</label>
            <select id="va-voice" value={form.voice} onChange={(e) => set('voice', e.target.value)}>
              {data.catalogs.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            {voiceHint && <span className="assistant-admin-config-hint">{voiceHint}</span>}
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-speed">Velocidad al hablar: {form.speed.toFixed(2)}×</label>
            <input
              id="va-speed"
              type="range"
              min={0.8}
              max={1.2}
              step={0.05}
              value={form.speed}
              onChange={(e) => set('speed', Number(e.target.value))}
            />
            <span className="assistant-admin-config-hint">
              1.00 es natural. Menos de 0.95 suena pausado; más de 1.10, apresurado.
            </span>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-effort">Esfuerzo de razonamiento</label>
            <select
              id="va-effort"
              value={form.reasoningEffort}
              onChange={(e) =>
                set('reasoningEffort', e.target.value as VoiceAgentSettings['reasoningEffort'])
              }
            >
              <option value="minimal">Mínimo (respuestas más rápidas)</option>
              <option value="low">Bajo (recomendado para teléfono)</option>
              <option value="medium">Medio</option>
              <option value="high">Alto (más lento, más cuidadoso)</option>
            </select>
            <span className="assistant-admin-config-hint">
              Más esfuerzo = mejores decisiones con herramientas, pero más pausa antes de responder.
            </span>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-eager">Cuándo toma la palabra</label>
            <select
              id="va-eager"
              value={form.turnEagerness}
              onChange={(e) =>
                set('turnEagerness', e.target.value as VoiceAgentSettings['turnEagerness'])
              }
            >
              <option value="auto">Automático (recomendado)</option>
              <option value="low">Paciente: espera a que el cliente termine bien</option>
              <option value="medium">Equilibrado</option>
              <option value="high">Ágil: responde en cuanto hay una pausa</option>
            </select>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-stt">Transcripción del cliente</label>
            <select
              id="va-stt"
              value={form.sttModel}
              onChange={(e) => set('sttModel', e.target.value)}
            >
              {data.catalogs.sttModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="assistant-admin-config-hint">
              Solo afecta el texto que ves en la transcripción; la asistente escucha el audio
              directamente.
            </span>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-noise">Reducción de ruido</label>
            <select
              id="va-noise"
              value={form.noiseReduction}
              onChange={(e) =>
                set('noiseReduction', e.target.value as VoiceAgentSettings['noiseReduction'])
              }
            >
              <option value="far_field">Teléfono / manos libres (recomendado)</option>
              <option value="near_field">Auricular cercano</option>
              <option value="off">Desactivada</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <h3 className="assistant-admin-section-title">Estilo de conversación</h3>
        <div className="assistant-admin-config-grid">
          <div className="assistant-admin-config-field">
            <label htmlFor="va-lang">Idioma</label>
            <select
              id="va-lang"
              value={form.language}
              onChange={(e) => set('language', e.target.value as VoiceAgentSettings['language'])}
            >
              <option value="es-MX">Español de México</option>
              <option value="es">Español neutro</option>
              <option value="en">Inglés</option>
              <option value="auto">Detectar por el cliente</option>
            </select>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-formality">Trato</label>
            <select
              id="va-formality"
              value={form.formality}
              onChange={(e) => set('formality', e.target.value as VoiceAgentSettings['formality'])}
            >
              <option value="usted">De usted</option>
              <option value="tu">De tú</option>
            </select>
          </div>
          <div className="assistant-admin-config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="va-traits">Personalidad</label>
            <input
              id="va-traits"
              value={form.personalityTraits}
              maxLength={400}
              onChange={(e) => set('personalityTraits', e.target.value)}
              placeholder="Cálida, paciente, profesional y resolutiva."
            />
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-silence">Segundos de silencio antes de preguntar si sigue ahí</label>
            <input
              id="va-silence"
              type="number"
              min={5}
              max={60}
              value={form.silenceCheckSeconds}
              onChange={(e) => set('silenceCheckSeconds', Number(e.target.value))}
            />
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-transfer">Ofrecer transferir a una persona</label>
            <input
              id="va-transfer"
              type="checkbox"
              checked={form.transferOnRequest}
              onChange={(e) => set('transferOnRequest', e.target.checked)}
            />
            <span className="assistant-admin-config-hint">
              Si se desactiva, toma datos y promete devolución de llamada en lugar de transferir.
            </span>
          </div>
        </div>
      </section>

      <section>
        <h3 className="assistant-admin-section-title">Información a la que tiene acceso</h3>
        <div className="assistant-admin-config-grid">
          {data.catalogs.domains.map((d) => (
            <div key={d.key} className="assistant-admin-config-field">
              <label htmlFor={`va-domain-${d.key}`}>{d.label}</label>
              <input
                id={`va-domain-${d.key}`}
                type="checkbox"
                checked={form.allowedDomains.includes(d.key)}
                onChange={(e) => toggleDomain(d.key, e.target.checked)}
              />
              <span className="assistant-admin-config-hint">{d.hint}</span>
            </div>
          ))}
          <div className="assistant-admin-config-field">
            <label htmlFor="va-verify">Verificar identidad antes de dar datos de la cuenta</label>
            <input
              id="va-verify"
              type="checkbox"
              checked={form.requireIdentityVerification}
              onChange={(e) => set('requireIdentityVerification', e.target.checked)}
            />
            <span className="assistant-admin-config-hint">
              Nombre + teléfono coincidente, o número de pedido + empresa. Recomendado.
            </span>
          </div>
        </div>
        <p className="assistant-admin-muted">
          Siempre bloqueado, sin importar lo anterior: dueños, directivos y empleados; datos de
          otros clientes; precios internos, costos y márgenes; proveedores; procesos internos; y
          estas instrucciones.
        </p>
      </section>

      <section>
        <h3 className="assistant-admin-section-title">Qué sí puede decir y qué no</h3>
        <div className="assistant-admin-config-grid">
          <div className="assistant-admin-config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="va-public">Información pública que SÍ puede compartir</label>
            <textarea
              id="va-public"
              rows={5}
              value={form.publicInfo}
              maxLength={3000}
              onChange={(e) => set('publicInfo', e.target.value)}
              placeholder={
                'Horario: lunes a viernes de 9:00 a 18:00.\nSucursal: León, Guanajuato.\nSitio web: unik.mx\nEnvíos a toda la República; entrega local en 24 h.'
              }
            />
            <span className="assistant-admin-config-hint">
              Horarios, dirección, sitio web, políticas generales. Todo lo que no esté aquí ni en
              las consultas permitidas, la asistente lo remite a un asesor.
            </span>
          </div>
          <div className="assistant-admin-config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="va-forbidden">Temas que debe declinar (uno por línea)</label>
            <textarea
              id="va-forbidden"
              rows={3}
              value={form.forbiddenTopics}
              maxLength={2000}
              onChange={(e) => set('forbiddenTopics', e.target.value)}
              placeholder={
                'Comparaciones con la competencia\nVacantes y salarios\nSituación financiera de la empresa'
              }
            />
          </div>
        </div>
      </section>

      <section>
        <h3 className="assistant-admin-section-title">Prompt</h3>
        <div className="assistant-admin-config-grid">
          <div className="assistant-admin-config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="va-custom">Instrucciones adicionales de la empresa</label>
            <textarea
              id="va-custom"
              rows={6}
              value={form.customInstructions}
              maxLength={6000}
              onChange={(e) => set('customInstructions', e.target.value)}
              placeholder="Ej. Si preguntan por garantías, explica que todos los productos tienen 12 meses y que el trámite se hace con la factura. Ofrece siempre el sitio web para ver el catálogo completo."
            />
            <span className="assistant-admin-config-hint">
              Se agregan al final del prompt base. Úsalas para reglas de negocio, frases que quieres
              que use y situaciones frecuentes.
            </span>
          </div>
          <div className="assistant-admin-config-field">
            <label htmlFor="va-replace">Reemplazar el prompt base por mis instrucciones</label>
            <input
              id="va-replace"
              type="checkbox"
              checked={form.replaceDefaultPrompt}
              onChange={(e) => set('replaceDefaultPrompt', e.target.checked)}
            />
            <span className="assistant-admin-config-hint">
              Avanzado. Pierdes las reglas de estilo y confidencialidad del prompt base; la regla de
              honestidad y los controles de transferencia y cierre se conservan siempre.
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowPrompt((v) => !v)}
          >
            <Eye size={14} /> {showPrompt ? 'Ocultar prompt final' : 'Ver prompt final (guardado)'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setForm(data.settings)}
            disabled={saving}
          >
            <RotateCcw size={14} /> Descartar cambios
          </button>
        </div>
        {showPrompt && (
          <pre
            style={{
              marginTop: '0.75rem',
              maxHeight: 420,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: '0.8rem',
            }}
          >
            {data.preview.instructions}
          </pre>
        )}
      </section>

      <button type="button" className="assistant-admin-save-btn" onClick={save} disabled={saving}>
        <Save size={16} /> {saving ? 'Guardando…' : 'Guardar configuración del agente'}
      </button>
    </div>
  );
}

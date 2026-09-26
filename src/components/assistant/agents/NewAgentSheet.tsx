'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import {
  AGENT_TEMPLATES,
  type AgentAutonomy,
  type AgentRoutine,
  type AgentTemplate,
  type AgentVenuePolicy,
} from '@/modules/agents/agent-templates';
import {
  AGENT_HUE_COUNT,
  AGENT_ICON_KEYS,
  AGENT_ICONS,
  agentFromRecord,
  type AgentInfo,
  type AgentRecordDTO,
} from './agent-types';
import { AgentAvatar } from './AgentAvatar';

/**
 * What the empty-state cards / the sidebar hand to the sheet: the visual seed
 * (name, purpose, icon, color) plus, when it comes from a full template, the
 * persona, tool allowlist, autonomy, venue policy and optional routine.
 */
export type NewAgentTemplate = Pick<AgentTemplate, 'name' | 'purpose' | 'icon' | 'color'> &
  Partial<
    Pick<
      AgentTemplate,
      'id' | 'persona' | 'toolAllowlist' | 'autonomy' | 'venuePolicy' | 'routine' | 'starters'
    >
  >;

/** Compact presets (kept for callers that only need the visual seed). */
export const AGENT_SUGGESTIONS: Array<{
  name: string;
  purpose: string;
  icon: string;
  color: number;
}> = AGENT_TEMPLATES.map((t) => ({
  name: t.name,
  purpose: t.purpose,
  icon: t.icon,
  color: t.color,
}));

const AUTONOMY_OPTIONS: Array<{ value: AgentAutonomy; label: string; hint: string }> = [
  {
    value: 'approval',
    label: 'Pide aprobación',
    hint: 'Lee solo; todo lo que tenga efecto espera tu OK.',
  },
  {
    value: 'notify',
    label: 'Avisa',
    hint: 'Lecturas y borradores solos; te avisa de cada efecto.',
  },
  {
    value: 'auto',
    label: 'Autónomo',
    hint: 'Lecturas, borradores y tareas internas sin preguntar.',
  },
];

const VENUE_OPTIONS: Array<{ value: AgentVenuePolicy; label: string }> = [
  { value: 'shared', label: 'Computadora compartida' },
  { value: 'dedicated', label: 'Computadora propia' },
  { value: 'ephemeral', label: 'Solo mientras trabaja' },
];

export interface NewAgentSheetProps {
  open: boolean;
  onClose: () => void;
  /** false while POST /app/assistant/api/agents does not exist — the form stays
   *  fully usable visually but cannot submit (no fake success). */
  supported: boolean;
  /** Pre-fill from an empty-state card or a template. */
  template?: NewAgentTemplate | null;
  onCreated?: (agent: AgentInfo) => void;
}

export function NewAgentSheet({
  open,
  onClose,
  supported,
  template,
  onCreated,
}: NewAgentSheetProps) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [color, setColor] = useState(1);
  const [icon, setIcon] = useState('research');
  const [persona, setPersona] = useState('');
  const [toolAllowlist, setToolAllowlist] = useState<string[]>([]);
  const [autonomy, setAutonomy] = useState<AgentAutonomy>('approval');
  const [venuePolicy, setVenuePolicy] = useState<AgentVenuePolicy>('shared');
  const [routine, setRoutine] = useState<AgentRoutine | null>(null);
  const [routineEnabled, setRoutineEnabled] = useState(true);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedKey = useRef<string | null>(null);

  function applyTemplate(t: NewAgentTemplate) {
    setTemplateId(t.id ?? null);
    setName(t.name);
    setPurpose(t.purpose);
    setIcon(t.icon);
    setColor(t.color);
    setPersona(t.persona ?? '');
    setToolAllowlist(t.toolAllowlist ?? []);
    setAutonomy(t.autonomy ?? 'approval');
    setVenuePolicy(t.venuePolicy ?? 'shared');
    setRoutine(t.routine ?? null);
    setRoutineEnabled(true);
  }

  // Apply the template the parent passed (once per open).
  useEffect(() => {
    if (!open) return;
    const key = template ? `${template.id ?? ''}:${template.name}` : null;
    if (template && appliedKey.current !== key) {
      appliedKey.current = key;
      applyTemplate(template);
    }
    if (!template) appliedKey.current = null;
    setError(null);
  }, [open, template]);

  const preview: AgentInfo = {
    id: 'preview',
    name: name || 'Agente',
    kind: 'specialist',
    color,
    icon,
  };
  const canSubmit = supported && name.trim().length > 0 && !busy;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/app/assistant/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          purpose: purpose.trim() || undefined,
          persona: persona.trim() || undefined,
          color: String(color),
          icon,
          autonomy,
          venuePolicy,
          toolAllowlist: toolAllowlist.length > 0 ? toolAllowlist : undefined,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error ?? 'No se pudo crear el agente');
      }
      const d = (await res.json()) as { agent?: AgentRecordDTO };
      const created: AgentInfo = d.agent
        ? agentFromRecord(d.agent)
        : {
            id: `agent-${Date.now()}`,
            name: name.trim(),
            kind: 'specialist',
            purpose,
            color,
            icon,
          };

      // The routine is a real `time` trigger on the new agent — created only
      // when the agent exists server-side (a real cuid, never the fallback id).
      let routineNote = '';
      if (routine && routineEnabled && d.agent?.id) {
        const tr = await fetch('/app/assistant/api/triggers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: d.agent.id,
            type: routine.type,
            spec: routine.spec,
            action: routine.action,
          }),
        }).catch(() => null);
        routineNote = tr?.ok
          ? ` · rutina: ${routine.label.toLowerCase()}`
          : ' · la rutina no se pudo programar';
      }

      onCreated?.(created);
      toast.success(`${name.trim()} se unió al equipo${routineNote}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el agente');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="agent-sheet uv-sheet">
        <DialogHeader>
          <DialogTitle>Nuevo agente</DialogTitle>
          <DialogDescription>
            Un especialista con su propio chat, misiones, herramientas y, si quieres, una rutina.
          </DialogDescription>
        </DialogHeader>

        <form className="agent-sheet-form" onSubmit={handleSubmit}>
          <div className="agent-sheet-preview">
            <AgentAvatar agent={preview} size="lg" />
            <div>
              <div className="agent-sheet-preview-name">{name || 'Sin nombre'}</div>
              <div className="agent-sheet-preview-sub">{purpose || 'Describe su propósito'}</div>
            </div>
          </div>

          <div className="agent-sheet-field">
            <span className="agent-sheet-label">Plantillas</span>
            <div className="uv-tpl-grid" role="listbox" aria-label="Plantillas de agente">
              {AGENT_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={templateId === t.id}
                  className={cn('uv-tpl', templateId === t.id && 'is-active')}
                  onClick={() => applyTemplate(t)}
                  title={t.useCase}
                >
                  <AgentAvatar agent={{ name: t.name, color: t.color, icon: t.icon }} size="xs" />
                  <span className="uv-tpl-text">
                    <span className="uv-tpl-name">{t.name}</span>
                    <span className="uv-tpl-sub">{t.purpose}</span>
                  </span>
                  {t.routine && (
                    <span className="uv-tpl-routine" title={t.routine.label}>
                      <CalendarClock size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {routine && (
            <label className="uv-routine">
              <input
                type="checkbox"
                checked={routineEnabled}
                onChange={(e) => setRoutineEnabled(e.target.checked)}
              />
              <span className="uv-routine-text">
                <span className="uv-routine-title">
                  <CalendarClock size={13} /> Programar rutina · {routine.label}
                </span>
                <span className="uv-routine-goal">{routine.action.goal}</span>
              </span>
            </label>
          )}

          <div className="agent-sheet-field">
            <span className="agent-sheet-label">Color</span>
            <div className="agent-color-row" role="radiogroup" aria-label="Color del agente">
              {Array.from({ length: AGENT_HUE_COUNT }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={color === i}
                  aria-label={`Color ${i + 1}`}
                  className={cn('agent-color-swatch', color === i && 'is-active')}
                  style={{ background: `var(--agent-hue-${i})` }}
                  onClick={() => setColor(i)}
                >
                  {color === i && <Check size={12} />}
                </button>
              ))}
            </div>
          </div>

          <div className="agent-sheet-field">
            <span className="agent-sheet-label">Icono</span>
            <div className="agent-icon-row" role="radiogroup" aria-label="Icono del agente">
              {AGENT_ICON_KEYS.map((key) => {
                const Ic = AGENT_ICONS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={icon === key}
                    aria-label={`Icono ${key}`}
                    className={cn('agent-icon-swatch', icon === key && 'is-active')}
                    onClick={() => setIcon(key)}
                  >
                    <Ic size={15} />
                  </button>
                );
              })}
            </div>
          </div>

          <label className="agent-sheet-field">
            <span className="agent-sheet-label">Nombre</span>
            <input
              type="text"
              className="agent-sheet-input"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 60))}
              placeholder="Cobranza"
              maxLength={60}
            />
          </label>

          <label className="agent-sheet-field">
            <span className="agent-sheet-label">Propósito</span>
            <textarea
              className="agent-sheet-input agent-sheet-textarea"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value.slice(0, 200))}
              placeholder="Qué hace, para quién, con qué datos"
              rows={2}
              maxLength={200}
            />
          </label>

          <button
            type="button"
            className="uv-sheet-toggle"
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
          >
            {advanced ? 'Ocultar ajustes avanzados' : 'Ajustes avanzados'}
            {!advanced && (
              <span className="uv-sheet-toggle-sub">
                {AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.label} ·{' '}
                {VENUE_OPTIONS.find((o) => o.value === venuePolicy)?.label}
                {toolAllowlist.length > 0
                  ? ` · ${toolAllowlist.length} herramientas`
                  : ' · todas las herramientas'}
              </span>
            )}
          </button>

          {advanced && (
            <div className="uv-sheet-advanced">
              <div className="agent-sheet-field">
                <span className="agent-sheet-label">Autonomía</span>
                <div className="uv-radio-cards" role="radiogroup" aria-label="Autonomía">
                  {AUTONOMY_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={autonomy === o.value}
                      className={cn('uv-radio-card', autonomy === o.value && 'is-active')}
                      onClick={() => setAutonomy(o.value)}
                    >
                      <span className="uv-radio-card-title">{o.label}</span>
                      <span className="uv-radio-card-hint">{o.hint}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="agent-sheet-field">
                <span className="agent-sheet-label">Computadora virtual</span>
                <select
                  className="agent-sheet-input"
                  value={venuePolicy}
                  onChange={(e) => setVenuePolicy(e.target.value as AgentVenuePolicy)}
                >
                  {VENUE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="agent-sheet-field">
                <span className="agent-sheet-label">Instrucciones (persona)</span>
                <textarea
                  className="agent-sheet-input agent-sheet-textarea"
                  value={persona}
                  onChange={(e) => setPersona(e.target.value.slice(0, 4000))}
                  placeholder="Si lo dejas vacío, se genera a partir del nombre y el propósito."
                  rows={4}
                  maxLength={4000}
                />
              </label>

              <label className="agent-sheet-field">
                <span className="agent-sheet-label">Herramientas permitidas</span>
                <textarea
                  className="agent-sheet-input agent-sheet-textarea"
                  value={toolAllowlist.join(', ')}
                  onChange={(e) =>
                    setToolAllowlist(
                      e.target.value
                        .split(/[\s,]+/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                    )
                  }
                  placeholder="Vacío = todas las que tú tengas. Solo puede acotar, nunca ampliar."
                  rows={3}
                />
              </label>
            </div>
          )}

          {error && (
            <div className="agent-sheet-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="agent-btn-primary"
            disabled={!canSubmit}
            title={!supported ? 'Disponible próximamente' : undefined}
          >
            {busy ? <Loader2 size={14} className="copilot-spin" /> : null}
            {routine && routineEnabled ? 'Crear agente y programar rutina' : 'Crear agente'}
          </button>
          {!supported && (
            <p className="agent-sheet-note" role="note">
              Disponible próximamente — el servicio de agentes aún no está activado.
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { cn } from '@/lib/utils';
import {
  AGENT_TEAMS,
  AGENT_TEMPLATES,
  TEMPLATE_CATEGORY_LABEL,
  teamMembers,
  type AgentAutonomy,
  type AgentTeamTemplate,
  type AgentTemplate,
  type AgentTemplateCategory,
  type AgentVenuePolicy,
} from '@/modules/agents/agent-templates';
import type { AgentInfo, AgentRecordDTO } from '../lib/types';
import { AGENT_HUE_COUNT, AGENT_ICONS, AGENT_ICON_KEYS, agentFromRecord } from '../lib/agents';
import { AgentAvatar } from '../ui';

/**
 * Hire a specialist (from a template or from scratch) or a whole team in one
 * click. Routines become real `time` triggers; a team hands its kickoff to the
 * director so work starts right away.
 */

const AUTONOMY: Array<{ value: AgentAutonomy; label: string; hint: string }> = [
  {
    value: 'approval',
    label: 'Pide aprobación',
    hint: 'Consulta solo; todo lo que tenga efecto espera tu OK.',
  },
  {
    value: 'notify',
    label: 'Avisa',
    hint: 'Consultas y borradores solos; te avisa de cada efecto.',
  },
  {
    value: 'auto',
    label: 'Autónomo',
    hint: 'Consultas, borradores y tareas internas sin preguntar.',
  },
];

const VENUE: Array<{ value: AgentVenuePolicy; label: string }> = [
  { value: 'shared', label: 'Comparte tu computadora virtual' },
  { value: 'dedicated', label: 'Su propia computadora virtual' },
  { value: 'ephemeral', label: 'Una computadora solo mientras trabaja' },
];

type Tab = 'specialist' | 'team';

interface FormState {
  templateId: string | null;
  name: string;
  purpose: string;
  icon: string;
  color: number;
  persona: string;
  toolAllowlist: string[];
  autonomy: AgentAutonomy;
  venuePolicy: AgentVenuePolicy;
  routine: AgentTemplate['routine'] | null;
  routineOn: boolean;
}

const BLANK: FormState = {
  templateId: null,
  name: '',
  purpose: '',
  icon: 'research',
  color: 1,
  persona: '',
  toolAllowlist: [],
  autonomy: 'approval',
  venuePolicy: 'shared',
  routine: null,
  routineOn: true,
};

function fromTemplate(t: AgentTemplate): FormState {
  return {
    templateId: t.id,
    name: t.name,
    purpose: t.purpose,
    icon: t.icon,
    color: t.color,
    persona: t.persona,
    toolAllowlist: t.toolAllowlist,
    autonomy: t.autonomy,
    venuePolicy: t.venuePolicy,
    routine: t.routine ?? null,
    routineOn: true,
  };
}

async function createOne(
  f: Omit<FormState, 'templateId' | 'routineOn'> & { routine: FormState['routine'] | null }
): Promise<{ agent: AgentInfo; routine: 'ok' | 'failed' | null }> {
  const res = await fetch('/app/assistant/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: f.name.trim(),
      purpose: f.purpose.trim() || undefined,
      persona: f.persona.trim() || undefined,
      color: String(f.color),
      icon: f.icon,
      autonomy: f.autonomy,
      venuePolicy: f.venuePolicy,
      toolAllowlist: f.toolAllowlist.length > 0 ? f.toolAllowlist : undefined,
    }),
  });
  const d = (await res.json().catch(() => ({}))) as { agent?: AgentRecordDTO; error?: string };
  if (!res.ok || !d.agent) throw new Error(d.error ?? `No se pudo crear «${f.name}»`);
  let routine: 'ok' | 'failed' | null = null;
  if (f.routine) {
    const tr = await fetch('/app/assistant/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: d.agent.id,
        type: f.routine.type,
        spec: f.routine.spec,
        action: f.routine.action,
      }),
    }).catch(() => null);
    routine = tr?.ok ? 'ok' : 'failed';
  }
  return { agent: agentFromRecord(d.agent), routine };
}

export function NewAgentDialog({
  open,
  onOpenChange,
  initialTeam,
  existingNames,
  onCreated,
  onKickoff,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open straight on a team (welcome screen chips). */
  initialTeam?: AgentTeamTemplate | null;
  existingNames: string[];
  onCreated: (agents: AgentInfo[], opts: { select: boolean }) => void;
  /** A team was created: the director starts with this message. */
  onKickoff: (text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('specialist');
  const [cat, setCat] = useState<AgentTemplateCategory | 'all'>('all');
  const [form, setForm] = useState<FormState>(BLANK);
  const [team, setTeam] = useState<AgentTeamTemplate | null>(null);
  const [kickoff, setKickoff] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(null);
    if (initialTeam) {
      setTab('team');
      setTeam(initialTeam);
    }
  }, [open, initialTeam]);

  const categories = useMemo(() => {
    const set = new Set(AGENT_TEMPLATES.map((t) => t.category));
    return [...set];
  }, []);
  const templates =
    cat === 'all' ? AGENT_TEMPLATES : AGENT_TEMPLATES.filter((t) => t.category === cat);
  const taken = useMemo(() => new Set(existingNames.map((n) => n.toLowerCase())), [existingNames]);

  const createSpecialist = async () => {
    if (!form.name.trim()) {
      setError('Ponle un nombre al agente.');
      return;
    }
    setBusy('specialist');
    setError(null);
    try {
      const { agent, routine } = await createOne({
        ...form,
        routine: form.routine && form.routineOn ? form.routine : null,
      });
      onCreated([agent], { select: true });
      toast.success(
        `${agent.name} se unió a tu equipo${routine === 'ok' ? ` · rutina: ${form.routine?.label.toLowerCase()}` : routine === 'failed' ? ' · la rutina no se pudo programar' : ''}`
      );
      setForm(BLANK);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el agente');
    } finally {
      setBusy(null);
    }
  };

  const createTeam = async () => {
    if (!team) return;
    setBusy('team');
    setError(null);
    const created: AgentInfo[] = [];
    const failed: string[] = [];
    for (const m of teamMembers(team)) {
      if (taken.has(m.name.toLowerCase())) continue;
      try {
        const { agent } = await createOne({ ...fromTemplate(m), routine: m.routine ?? null });
        created.push(agent);
      } catch {
        failed.push(m.name);
      }
    }
    setBusy(null);
    if (created.length === 0 && failed.length > 0) {
      setError(`No se pudo crear el equipo (${failed.join(', ')}).`);
      return;
    }
    onCreated(created, { select: false });
    toast.success(
      created.length > 0
        ? `${team.name}: ${created.length} especialista${created.length > 1 ? 's' : ''} listos${failed.length ? ` · faltaron ${failed.join(', ')}` : ''}`
        : `${team.name} ya estaba en tu equipo`
    );
    onOpenChange(false);
    if (kickoff) onKickoff(team.kickoff);
  };

  const preview = { name: form.name || 'Nuevo agente', color: form.color, icon: form.icon };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="uv-dialog uv-scope" showCloseButton={false}>
        <div className="uv-dialog-head">
          <DialogClose asChild>
            <button
              type="button"
              className="uv-icon-btn uv-dialog-close"
              aria-label="Cerrar"
              disabled={busy !== null}
            >
              <X size={17} />
            </button>
          </DialogClose>
          <DialogTitle asChild>
            <h2>Amplía tu equipo</h2>
          </DialogTitle>
          <DialogDescription asChild>
            <p>
              Cada especialista tiene su chat, sus herramientas y su forma de trabajar. El director
              les reparte el trabajo y revisa sus entregas.
            </p>
          </DialogDescription>
          <div className="uv-subtabs" role="tablist" style={{ marginTop: 12 }}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'specialist'}
              className={cn(tab === 'specialist' && 'is-active')}
              onClick={() => setTab('specialist')}
            >
              <Sparkles size={13} /> Especialista
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'team'}
              className={cn(tab === 'team' && 'is-active')}
              onClick={() => setTab('team')}
            >
              <Users size={13} /> Equipo completo
            </button>
          </div>
        </div>

        {tab === 'specialist' ? (
          <div className="uv-dialog-body">
            <div className="uv-cat-tabs" role="tablist" aria-label="Áreas">
              <button
                type="button"
                className={cn(cat === 'all' && 'is-active')}
                onClick={() => setCat('all')}
              >
                Todos
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={cn(cat === c && 'is-active')}
                  onClick={() => setCat(c)}
                >
                  {TEMPLATE_CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            <div className="uv-tpl-grid" role="listbox" aria-label="Plantillas">
              {templates.map((t) => {
                const exists = taken.has(t.name.toLowerCase());
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={form.templateId === t.id}
                    className={cn('uv-tpl', form.templateId === t.id && 'is-active')}
                    onClick={() => setForm(fromTemplate(t))}
                    title={t.useCase}
                  >
                    <AgentAvatar agent={{ name: t.name, color: t.color, icon: t.icon }} size="sm" />
                    <span className="uv-tpl-text">
                      <span className="uv-tpl-name">
                        {t.name}
                        {t.routine && <CalendarClock size={12} aria-label="Con rutina" />}
                        {exists && <span className="uv-pill">Ya lo tienes</span>}
                      </span>
                      <span className="uv-tpl-sub">{t.purpose}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="uv-form-grid">
              <label className="uv-form-field">
                <span className="uv-form-label">Nombre</span>
                <input
                  className="uv-input"
                  value={form.name}
                  maxLength={60}
                  placeholder="Cobranza"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <div className="uv-form-field">
                <span className="uv-form-label">Así se verá</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }}>
                  <AgentAvatar agent={preview} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{preview.name}</span>
                </div>
              </div>
              <label className="uv-form-field is-wide">
                <span className="uv-form-label">Qué hace</span>
                <textarea
                  className="uv-textarea"
                  rows={2}
                  maxLength={200}
                  value={form.purpose}
                  placeholder="Qué hace, para quién y con qué datos"
                  onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                />
              </label>
              <div className="uv-form-field">
                <span className="uv-form-label">Color</span>
                <div className="uv-swatches" role="radiogroup" aria-label="Color">
                  {Array.from({ length: AGENT_HUE_COUNT }, (_, i) => (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={form.color === i}
                      aria-label={`Color ${i + 1}`}
                      className={cn('uv-swatch', form.color === i && 'is-active')}
                      style={{ background: `var(--agent-hue-${i})` }}
                      onClick={() => setForm({ ...form, color: i })}
                    >
                      {form.color === i && <Check size={12} />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="uv-form-field">
                <span className="uv-form-label">Icono</span>
                <div className="uv-swatches" role="radiogroup" aria-label="Icono">
                  {AGENT_ICON_KEYS.map((k) => {
                    const Ic = AGENT_ICONS[k];
                    return (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={form.icon === k}
                        aria-label={`Icono ${k}`}
                        className={cn('uv-swatch is-icon', form.icon === k && 'is-active')}
                        onClick={() => setForm({ ...form, icon: k })}
                      >
                        <Ic size={14} />
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {form.routine && (
              <label className="uv-routine">
                <input
                  type="checkbox"
                  checked={form.routineOn}
                  onChange={(e) => setForm({ ...form, routineOn: e.target.checked })}
                />
                <span>
                  <strong>
                    <CalendarClock size={13} /> Rutina · {form.routine.label}
                  </strong>
                  {form.routine.action.goal}
                </span>
              </label>
            )}

            <button
              type="button"
              className="uv-disclosure"
              onClick={() => setAdvanced((v) => !v)}
              aria-expanded={advanced}
            >
              {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Autonomía,
              computadora e instrucciones
            </button>
            {advanced && (
              <div className="uv-form-grid">
                <div className="uv-form-field is-wide">
                  <span className="uv-form-label">Autonomía</span>
                  <div
                    className="uv-seg"
                    role="radiogroup"
                    aria-label="Autonomía"
                    style={{ alignSelf: 'flex-start' }}
                  >
                    {AUTONOMY.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={form.autonomy === o.value}
                        title={o.hint}
                        onClick={() => setForm({ ...form, autonomy: o.value })}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <span className="uv-card-source">
                    {AUTONOMY.find((o) => o.value === form.autonomy)?.hint}
                  </span>
                </div>
                <label className="uv-form-field is-wide">
                  <span className="uv-form-label">Computadora virtual</span>
                  <select
                    className="uv-input"
                    value={form.venuePolicy}
                    onChange={(e) =>
                      setForm({ ...form, venuePolicy: e.target.value as AgentVenuePolicy })
                    }
                  >
                    {VENUE.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="uv-form-field is-wide">
                  <span className="uv-form-label">Instrucciones</span>
                  <textarea
                    className="uv-textarea"
                    rows={4}
                    maxLength={4000}
                    value={form.persona}
                    placeholder="Si lo dejas vacío se generan a partir del nombre y de lo que hace."
                    onChange={(e) => setForm({ ...form, persona: e.target.value })}
                  />
                </label>
                <label className="uv-form-field is-wide">
                  <span className="uv-form-label">Herramientas permitidas</span>
                  <textarea
                    className="uv-textarea"
                    rows={2}
                    value={form.toolAllowlist.join(', ')}
                    placeholder="Vacío = todas las que tú tienes. Solo puede acotar, nunca ampliar tus permisos."
                    onChange={(e) =>
                      setForm({
                        ...form,
                        toolAllowlist: e.target.value
                          .split(/[\s,]+/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </div>
            )}
            {error && (
              <div className="uv-dialog-error" role="alert">
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="uv-dialog-body">
            <div className="uv-tpl-grid" role="listbox" aria-label="Equipos">
              {AGENT_TEAMS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={team?.id === t.id}
                  className={cn('uv-tpl', team?.id === t.id && 'is-active')}
                  onClick={() => setTeam(t)}
                  title={t.useCase}
                >
                  <AgentAvatar agent={{ name: t.name, color: t.color, icon: t.icon }} size="sm" />
                  <span className="uv-tpl-text">
                    <span className="uv-tpl-name">{t.name}</span>
                    <span className="uv-tpl-sub">{t.purpose}</span>
                    <span className="uv-tpl-members">
                      {teamMembers(t).map((m) => (
                        <AgentAvatar
                          key={m.id}
                          agent={{ name: m.name, color: m.color, icon: m.icon }}
                          size="xs"
                        />
                      ))}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {team && (
              <section className="uv-card">
                <div className="uv-card-head">
                  <span className="uv-card-icon">
                    <Users size={16} />
                  </span>
                  <div className="uv-card-title">
                    <strong>{team.name}</strong>
                    <span>{teamMembers(team).length} especialistas · el director los coordina</span>
                  </div>
                </div>
                <div className="uv-team-list">
                  {teamMembers(team).map((m) => (
                    <div key={m.id} className="uv-team-item">
                      <AgentAvatar
                        agent={{ name: m.name, color: m.color, icon: m.icon }}
                        size="sm"
                      />
                      <div className="uv-team-item-main">
                        <div className="uv-team-item-title">
                          <span>{m.name}</span>
                          {taken.has(m.name.toLowerCase()) && (
                            <span className="uv-pill">Ya lo tienes</span>
                          )}
                          {m.routine && (
                            <span className="uv-pill is-accent">
                              <CalendarClock size={11} /> {m.routine.label}
                            </span>
                          )}
                        </div>
                        <div className="uv-team-item-sub">{m.purpose}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="uv-card-foot">
                  <label className="uv-check">
                    <input
                      type="checkbox"
                      checked={kickoff}
                      onChange={(e) => setKickoff(e.target.checked)}
                    />
                    Que el director arranque ahora: «{team.kickoff.slice(0, 90)}
                    {team.kickoff.length > 90 ? '…' : ''}»
                  </label>
                </div>
              </section>
            )}
            {error && (
              <div className="uv-dialog-error" role="alert">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="uv-dialog-foot">
          <span className="uv-grow">
            {tab === 'specialist'
              ? 'Sus permisos nunca superan los tuyos. Lo que tenga efectos te pedirá aprobación.'
              : 'Se crean los especialistas que aún no tienes, con sus rutinas.'}
          </span>
          <button
            type="button"
            className="uv-btn is-ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy !== null}
          >
            Cancelar
          </button>
          {tab === 'specialist' ? (
            <button
              type="button"
              className="uv-btn is-primary"
              onClick={() => void createSpecialist()}
              disabled={busy !== null || !form.name.trim()}
            >
              {busy === 'specialist' && <Loader2 size={14} className="uv-spin" />}
              {form.routine && form.routineOn ? 'Crear y programar rutina' : 'Crear agente'}
            </button>
          ) : (
            <button
              type="button"
              className="uv-btn is-primary"
              onClick={() => void createTeam()}
              disabled={busy !== null || !team}
            >
              {busy === 'team' && <Loader2 size={14} className="uv-spin" />}
              {team ? `Crear ${team.name}` : 'Elige un equipo'}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

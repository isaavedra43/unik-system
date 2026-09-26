'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  FileText,
  Import,
  ListChecks,
  Loader2,
  MessageCircle,
  MessagesSquare,
  Pause,
  Phone,
  Play,
  Rocket,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { listItem } from '@/lib/motion';
import { cn } from '@/lib/utils';
import {
  RUN_PLAN_MESSAGE,
  toolLabel,
  type MissionCardData,
  type PlanData,
} from '@/components/copilot/copilot-types';
import type { ProposalExecution, ProposalInfo, TeamTask } from '../lib/types';
import { MISSION_STATUS_LABEL, scheduleLabel } from '../lib/missions';
import { formatDuration, timeAgo } from '../lib/format';

/**
 * Agentic cards: what the agents propose or report — approvals (nothing with
 * side effects runs until the user says so), plans, missions, reports from the
 * team and routines. Every button hits the real API.
 */

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

const EFFECT_META: Record<
  string,
  { label: string; icon: React.ReactNode; tone: 'send' | 'write' | 'danger' | 'task' }
> = {
  external_send: { label: 'Envío / llamada', icon: <Send size={12} />, tone: 'send' },
  business_write: { label: 'Cambio en el sistema', icon: <FileText size={12} />, tone: 'write' },
  destructive: { label: 'Acción destructiva', icon: <Trash2 size={12} />, tone: 'danger' },
  internal_task: { label: 'Tarea interna', icon: <Sparkles size={12} />, tone: 'task' },
  draft: { label: 'Borrador', icon: <FileText size={12} />, tone: 'task' },
};

const TOOL_TITLE: Record<string, string> = {
  sendInboxMessage: 'Enviar mensaje al cliente',
  sendMessageToContact: 'Enviar mensaje al contacto',
  sendBulkMessages: 'Envío a varios contactos',
  sendQuoteToContact: 'Enviar cotización con PDF de Zoho',
  sendInternalChatMessage: 'Enviar por chat interno',
  callContact: 'Llamada telefónica',
  startOutboundCall: 'Llamada telefónica',
  createQuote: 'Crear cotización en Zoho Books',
  updateQuote: 'Editar cotización en Zoho Books',
  approveCampaign: 'Aprobar campaña',
  cleanupArtifacts: 'Limpiar archivos generados',
  publishSite: 'Publicar sitio web',
  unpublishSite: 'Despublicar sitio web',
  composioExecute: 'Usar una app conectada',
  browser: 'Acción en el navegador',
  computer: 'Acción en la computadora',
  delegateTask: 'Delegar al equipo',
  saveVenuePlaybook: 'Guardar automatización',
  rememberForUser: 'Guardar en tu memoria',
};

const TOOL_ICON: Record<string, React.ReactNode> = {
  sendInboxMessage: <MessageCircle size={16} />,
  sendMessageToContact: <MessageCircle size={16} />,
  sendBulkMessages: <MessageCircle size={16} />,
  sendInternalChatMessage: <MessageCircle size={16} />,
  sendQuoteToContact: <FileText size={16} />,
  callContact: <Phone size={16} />,
  startOutboundCall: <Phone size={16} />,
  createQuote: <FileText size={16} />,
  updateQuote: <FileText size={16} />,
  publishSite: <Rocket size={16} />,
};

const DECIDED_LABEL: Record<string, string> = {
  executed: 'Ejecutada',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  expired: 'Expirada',
  invalidated: 'Ya no es válida',
  failed: 'Falló',
};

function humanTool(name: string): string {
  return TOOL_TITLE[name] ?? toolLabel(name, 'running');
}

function proposalPreview(args: unknown): {
  body: string | null;
  recipients: string[];
  attachments: number;
  url: string | null;
} {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const body =
    (typeof a.body === 'string' && a.body) ||
    (typeof a.content === 'string' && a.content) ||
    (typeof a.message === 'string' && a.message) ||
    (typeof a.brief === 'string' && a.brief) ||
    (typeof a.goal === 'string' && a.goal) ||
    null;
  const recipients: string[] = [];
  if (typeof a.contact === 'string') recipients.push(a.contact);
  if (typeof a.toNumber === 'string') recipients.push(a.toNumber);
  if (typeof a.to === 'string') recipients.push(a.to);
  if (Array.isArray(a.recipients)) {
    for (const r of a.recipients as Array<{ contact?: string } | string>) {
      if (typeof r === 'string') recipients.push(r);
      else if (r?.contact) recipients.push(r.contact);
    }
  }
  const att = a.attachments as
    { artifactIds?: unknown[]; knowledgeSourceIds?: unknown[] } | undefined;
  const attachments = (att?.artifactIds?.length ?? 0) + (att?.knowledgeSourceIds?.length ?? 0);
  const url = typeof a.url === 'string' ? a.url : null;
  return { body, recipients, attachments, url };
}

function expiresIn(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes >= 1440) return `${Math.round(minutes / 1440)} d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} h`;
  return `${minutes} min`;
}

export function ApprovalCard({
  proposal,
  onDecided,
  onHandoff,
}: {
  proposal: ProposalInfo;
  /** Called with the updated proposal (+ execution when approved). */
  onDecided: (updated: ProposalInfo, execution?: ProposalExecution) => void;
  /** Optional: put the draft in the composer so the user sends it by hand. */
  onHandoff?: (text: string) => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = EFFECT_META[proposal.effect] ?? EFFECT_META.internal_task;
  const preview = proposalPreview(proposal.args);
  const decided =
    proposal.status && proposal.status !== 'pending'
      ? (DECIDED_LABEL[proposal.status] ?? proposal.status)
      : null;
  const rejected =
    proposal.status === 'rejected' ||
    proposal.status === 'invalidated' ||
    proposal.status === 'expired';

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/app/assistant/api/proposals/${proposal.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: action === 'reject' ? JSON.stringify({}) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        proposal?: ProposalInfo;
        execution?: ProposalExecution;
      };
      if (!res.ok) {
        if (res.status === 409 || res.status === 410)
          onDecided({ ...proposal, status: 'invalidated' });
        throw new Error(data.error ?? 'No se pudo procesar');
      }
      onDecided(
        {
          ...(data.proposal ?? proposal),
          status: data.proposal?.status ?? (action === 'approve' ? 'executed' : 'rejected'),
        },
        action === 'approve' ? data.execution : undefined
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo procesar');
    } finally {
      setBusy(null);
    }
  };

  return (
    <motion.section
      className={cn('uv-card uv-approval', decided && (rejected ? 'is-rejected' : 'is-done'))}
      role="group"
      aria-label={decided ? `Acción ${decided.toLowerCase()}` : 'Acción pendiente de tu aprobación'}
      variants={listItem}
      initial="initial"
      animate="animate"
    >
      <div className="uv-card-head">
        <span
          className={cn(
            'uv-card-icon',
            decided ? (rejected ? '' : 'is-ok') : meta.tone === 'danger' ? 'is-danger' : 'is-warn'
          )}
        >
          {decided ? (
            rejected ? (
              <XCircle size={16} />
            ) : (
              <CheckCircle2 size={16} />
            )
          ) : (
            (TOOL_ICON[proposal.toolName] ?? <ShieldAlert size={16} />)
          )}
        </span>
        <div className="uv-card-title">
          <strong>{decided ?? 'Necesita tu aprobación'}</strong>
          <span>
            {humanTool(proposal.toolName)}
            {!decided && proposal.expiresAt ? ` · caduca en ${expiresIn(proposal.expiresAt)}` : ''}
          </span>
        </div>
        <span
          className={cn(
            'uv-pill',
            meta.tone === 'danger' ? 'is-danger' : meta.tone === 'send' ? 'is-warn' : 'is-info'
          )}
        >
          {meta.icon}
          {meta.label}
        </span>
      </div>
      <div className="uv-card-body">
        {(preview.recipients.length > 0 ||
          proposal.recipient ||
          preview.url ||
          preview.attachments > 0) && (
          <dl className="uv-fields" style={{ marginTop: 0, marginBottom: 10 }}>
            {preview.recipients.length > 0 ? (
              <div className="uv-field">
                <dt>Para</dt>
                <dd>
                  {preview.recipients.slice(0, 4).join(', ')}
                  {preview.recipients.length > 4 ? ` y ${preview.recipients.length - 4} más` : ''}
                </dd>
              </div>
            ) : proposal.recipient ? (
              <div className="uv-field">
                <dt>Destino</dt>
                <dd>{proposal.recipient}</dd>
              </div>
            ) : null}
            {preview.url && (
              <div className="uv-field">
                <dt>Sitio</dt>
                <dd>{preview.url}</dd>
              </div>
            )}
            {preview.attachments > 0 && (
              <div className="uv-field">
                <dt>Adjuntos</dt>
                <dd>{preview.attachments} archivo(s)</dd>
              </div>
            )}
          </dl>
        )}
        <div className="uv-approval-summary">
          {preview.body ? <div className="uv-quote">{preview.body}</div> : proposal.summary}
        </div>
        {preview.body && proposal.summary && <p className="uv-approval-note">{proposal.summary}</p>}
        {proposal.args !== undefined && (
          <div className="uv-approval-args">
            <button
              type="button"
              className="uv-disclosure"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Ver detalle exacto
            </button>
            {open && (
              <pre className="uv-pre" style={{ marginTop: 6 }}>
                {JSON.stringify(proposal.args, null, 2)}
              </pre>
            )}
          </div>
        )}
        {proposal.error && decided && (
          <div className="uv-banner" style={{ marginTop: 10 }} role="alert">
            <span>{proposal.error}</span>
          </div>
        )}
        {error && (
          <div className="uv-banner" style={{ marginTop: 10 }} role="alert">
            <span>{error}</span>
          </div>
        )}
      </div>
      {!decided && (
        <div className="uv-card-foot">
          {onHandoff && preview.body && (
            <button
              type="button"
              className="uv-btn is-ghost is-sm"
              disabled={busy !== null}
              onClick={() => onHandoff(preview.body ?? '')}
            >
              <Import size={13} /> Editar yo
            </button>
          )}
          <span className="uv-grow" />
          <button
            type="button"
            className="uv-btn is-secondary is-sm"
            disabled={busy !== null}
            onClick={() => void decide('reject')}
          >
            {busy === 'reject' ? <Loader2 size={13} className="uv-spin" /> : <X size={13} />}{' '}
            Rechazar
          </button>
          <button
            type="button"
            className={cn('uv-btn is-sm', meta.tone === 'danger' ? 'is-danger' : 'is-primary')}
            disabled={busy !== null}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' ? <Loader2 size={13} className="uv-spin" /> : <Check size={13} />}{' '}
            Aprobar y ejecutar
          </button>
        </div>
      )}
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export function PlanCard({
  plan,
  active,
  onRun,
  onAdjust,
}: {
  plan: PlanData;
  active: boolean;
  onRun: (text: string) => void;
  onAdjust?: () => void;
}) {
  const approvals = plan.steps.filter((s) => s.needsApproval).length;
  return (
    <motion.section
      className="uv-card"
      role="group"
      aria-label="Plan propuesto"
      variants={listItem}
      initial="initial"
      animate="animate"
    >
      <div className="uv-card-head">
        <span className="uv-card-icon">
          <ListChecks size={16} />
        </span>
        <div className="uv-card-title">
          <strong>Plan propuesto</strong>
          <span>{plan.goal}</span>
        </div>
        <span className="uv-pill">{plan.steps.length} pasos</span>
      </div>
      <div className="uv-card-body">
        <ol className="uv-plan-steps">
          {plan.steps.map((step) => (
            <li key={step.n} className="uv-plan-step">
              <span className="uv-plan-n">{step.n}</span>
              <div className="uv-plan-step-text">
                {step.title}
                {step.detail && <small>{step.detail}</small>}
                {(step.tool || step.needsApproval) && (
                  <span className="uv-plan-tags">
                    {step.tool && (
                      <span className="uv-pill">{toolLabel(step.tool, 'running')}</span>
                    )}
                    {step.needsApproval && (
                      <span className="uv-pill is-warn">
                        <ShieldAlert size={11} /> pedirá aprobación
                      </span>
                    )}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
        {plan.assumptions.length > 0 && (
          <div className="uv-plan-extra">
            <span className="uv-step-detail-label">Supuestos</span>
            <ul>
              {plan.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        {plan.deliverable && (
          <div className="uv-plan-extra">
            <span className="uv-step-detail-label">Entregable</span>
            <p>{plan.deliverable}</p>
          </div>
        )}
      </div>
      <div className="uv-card-foot">
        {active ? (
          <>
            {onAdjust && (
              <button type="button" className="uv-btn is-ghost is-sm" onClick={onAdjust}>
                <SlidersHorizontal size={13} /> Ajustar
              </button>
            )}
            <span className="uv-grow" />
            <button
              type="button"
              className="uv-btn is-primary is-sm"
              onClick={() => onRun(RUN_PLAN_MESSAGE)}
            >
              <Play size={13} /> Ejecutar plan
              {approvals > 0 ? ` · ${approvals} aprobación${approvals > 1 ? 'es' : ''}` : ''}
            </button>
          </>
        ) : (
          <span className="uv-card-source">Plan anterior</span>
        )}
      </div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/* Mission                                                             */
/* ------------------------------------------------------------------ */

interface LiveStep {
  title: string;
  status: string;
  agent?: string | null;
}

const STEP_LABEL: Record<string, string> = {
  pending: 'en espera',
  running: 'en curso',
  awaiting_approval: 'esperando aprobación',
  done: 'listo',
  failed: 'falló',
  skipped: 'omitido',
};

const MISSION_TONE: Record<string, string> = {
  active: 'is-accent',
  awaiting_approval: 'is-warn',
  blocked: 'is-warn',
  done: 'is-live',
  failed: 'is-danger',
  cancelled: '',
};

function StepIcon({ status }: { status: string }) {
  if (status === 'done' || status === 'skipped') return <Check size={12} />;
  if (status === 'running') return <Loader2 size={12} className="uv-spin" />;
  if (status === 'awaiting_approval') return <Clock size={12} />;
  if (status === 'failed') return <XCircle size={12} />;
  return <Circle size={10} />;
}

export function MissionCard({ mission, active }: { mission: MissionCardData; active: boolean }) {
  const [status, setStatus] = useState(mission.initialStatus ?? 'awaiting_approval');
  const [steps, setSteps] = useState<LiveStep[]>(mission.steps);
  const [busy, setBusy] = useState<string | null>(null);

  // Live status while the mission is in flight (each step still asks for approval).
  useEffect(() => {
    if (!['active', 'awaiting_approval', 'blocked'].includes(status)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/app/assistant/api/missions/${mission.missionId}`);
        if (!res.ok || cancelled) return;
        const d = (await res.json()) as {
          mission?: { status?: string; plan?: { steps?: LiveStep[] } | null };
        };
        if (!d.mission || cancelled) return;
        if (d.mission.status) setStatus(d.mission.status);
        const live = d.mission.plan?.steps;
        if (Array.isArray(live) && live.length > 0) setSteps(live);
      } catch {
        /* best effort */
      }
    };
    void tick();
    const i = window.setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(i);
    };
  }, [mission.missionId, status]);

  const act = async (action: 'approve' | 'pause' | 'resume' | 'cancel') => {
    setBusy(action);
    try {
      const res = await fetch(`/app/assistant/api/missions/${mission.missionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok)
        throw new Error(
          ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Error'
        );
      setStatus(
        action === 'approve' || action === 'resume'
          ? 'active'
          : action === 'cancel'
            ? 'cancelled'
            : 'blocked'
      );
      toast.success(
        action === 'approve'
          ? 'Misión en marcha. Te aviso al terminar.'
          : action === 'cancel'
            ? 'Misión cancelada'
            : action === 'pause'
              ? 'Misión pausada'
              : 'Misión reanudada'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo aplicar');
    } finally {
      setBusy(null);
    }
  };

  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const sched = scheduleLabel(mission.schedule);

  return (
    <motion.section
      className="uv-card"
      role="group"
      aria-label="Misión"
      variants={listItem}
      initial="initial"
      animate="animate"
    >
      <div className="uv-card-head">
        <span className="uv-card-icon">
          <Rocket size={16} />
        </span>
        <div className="uv-card-title">
          <strong>Misión</strong>
          <span>{mission.goal}</span>
        </div>
        <span className={cn('uv-pill', MISSION_TONE[status] ?? '')}>
          {MISSION_STATUS_LABEL[status] ?? status}
        </span>
      </div>
      {(sched || steps.length > 0) && (
        <div className="uv-card-body">
          {sched && (
            <p
              className="uv-card-source"
              style={{ margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <CalendarClock size={13} /> Rutina: {sched}
            </p>
          )}
          {steps.length > 0 && (
            <>
              <ol className="uv-plan-steps">
                {steps.map((step, i) => (
                  <li
                    key={i}
                    className={cn(
                      'uv-plan-step',
                      step.status === 'done' && 'is-done',
                      step.status === 'running' && 'is-running'
                    )}
                  >
                    <span className="uv-plan-n">
                      <StepIcon status={step.status} />
                    </span>
                    <div className="uv-plan-step-text">
                      {step.title}
                      <small>
                        {STEP_LABEL[step.status] ?? step.status}
                        {step.agent ? ` · ${step.agent}` : ''}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="uv-progress" aria-hidden="true">
                <i style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
              </div>
            </>
          )}
        </div>
      )}
      {active &&
        (status === 'awaiting_approval' || status === 'active' || status === 'blocked') && (
          <div className="uv-card-foot">
            {status === 'active' && (
              <span className="uv-card-source uv-grow">
                Cada efecto externo te pedirá aprobación.
              </span>
            )}
            {status !== 'active' && <span className="uv-grow" />}
            {status === 'active' && (
              <button
                type="button"
                className="uv-btn is-secondary is-sm"
                disabled={busy !== null}
                onClick={() => void act('pause')}
              >
                <Pause size={13} /> Pausar
              </button>
            )}
            {status !== 'active' && (
              <button
                type="button"
                className="uv-btn is-ghost is-sm"
                disabled={busy !== null}
                onClick={() => void act('cancel')}
              >
                <XCircle size={13} /> Cancelar
              </button>
            )}
            {status === 'awaiting_approval' && (
              <button
                type="button"
                className="uv-btn is-primary is-sm"
                disabled={busy !== null}
                onClick={() => void act('approve')}
              >
                {busy === 'approve' ? (
                  <Loader2 size={13} className="uv-spin" />
                ) : (
                  <Play size={13} />
                )}{' '}
                Aprobar y ejecutar
              </button>
            )}
            {status === 'blocked' && (
              <button
                type="button"
                className="uv-btn is-primary is-sm"
                disabled={busy !== null}
                onClick={() => void act('resume')}
              >
                <Play size={13} /> Reanudar
              </button>
            )}
          </div>
        )}
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/* Team report / routine / delegated tasks                             */
/* ------------------------------------------------------------------ */

/** Folded inter-agent chatter: "Mensajes de Investigador y Cobranza". */
export function AgentReportCard({ data }: { data: { agents?: string[]; summary?: string } }) {
  const [open, setOpen] = useState(false);
  const agents = (data.agents ?? []).filter((a) => typeof a === 'string' && a.trim());
  if (agents.length === 0 || !data.summary) return null;
  const title = `Mensajes de ${agents.slice(0, 2).join(' y ')}${agents.length > 2 ? ` +${agents.length - 2}` : ''}`;
  return (
    <section className="uv-card">
      <button
        type="button"
        className="uv-card-head uv-card-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="uv-card-icon">
          <MessagesSquare size={16} />
        </span>
        <span className="uv-card-title">
          <strong>{title}</strong>
          <span>Lo que se dijeron los agentes para llegar a esta respuesta</span>
        </span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div className="uv-card-body">
          <p className="uv-approval-summary" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {data.summary}
          </p>
        </div>
      )}
    </section>
  );
}

export function RoutineNote({ data }: { data: { name?: string; schedule?: string } }) {
  const sched = scheduleLabel(data.schedule ?? null);
  if (!data.name && !sched) return null;
  return (
    <div className="uv-event is-ok" role="status">
      <CalendarClock size={14} />
      <span>
        Rutina creada{data.name ? ` · ${data.name}` : ''}
        {sched ? ` · ${sched.toLowerCase()}` : ''}
      </span>
    </div>
  );
}

const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'En cola', tone: '' },
  pending: { label: 'En cola', tone: '' },
  running: { label: 'Trabajando', tone: 'is-accent' },
  done: { label: 'Listo', tone: 'is-live' },
  completed: { label: 'Listo', tone: 'is-live' },
  failed: { label: 'Falló', tone: 'is-danger' },
  cancelled: { label: 'Cancelada', tone: '' },
  timeout: { label: 'Se agotó el tiempo', tone: 'is-warn' },
};

export function taskStatus(status: string): { label: string; tone: string } {
  return TASK_STATUS[status] ?? { label: status, tone: '' };
}

/** Live card of the work the director delegated in this turn. */
export function TeamRunCard({
  tasks,
  agentName,
  onOpenTask,
}: {
  tasks: TeamTask[];
  agentName?: (id?: string | null) => string | null;
  onOpenTask?: (task: TeamTask) => void;
}) {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) =>
    ['done', 'completed', 'failed', 'cancelled', 'timeout'].includes(t.status)
  ).length;
  const running = tasks.length - done;
  return (
    <motion.section
      className="uv-card"
      aria-label="Trabajo del equipo"
      variants={listItem}
      initial="initial"
      animate="animate"
    >
      <div className="uv-card-head">
        <span className="uv-card-icon">
          <Users size={16} />
        </span>
        <div className="uv-card-title">
          <strong>
            {running > 0
              ? `Tu equipo trabaja en ${running} tarea${running > 1 ? 's' : ''}`
              : 'El equipo terminó'}
          </strong>
          <span>
            {done}/{tasks.length} completadas · el director revisa y consolida al final
          </span>
        </div>
        {running > 0 && (
          <Loader2 size={15} className="uv-spin" style={{ color: 'var(--uv-accent-text)' }} />
        )}
      </div>
      <div className="uv-team-list">
        {tasks.map((t) => {
          const st = taskStatus(t.status);
          const who = agentName?.(t.agentId) ?? null;
          const Row = onOpenTask ? 'button' : 'div';
          return (
            <Row
              key={t.taskId}
              className={cn('uv-team-item', onOpenTask && 'is-link')}
              {...(onOpenTask ? { type: 'button' as const, onClick: () => onOpenTask(t) } : {})}
            >
              <div className="uv-team-item-main">
                <div className="uv-team-item-title">
                  <span>{t.title}</span>
                  <span className={cn('uv-pill', st.tone)}>{st.label}</span>
                </div>
                <div className="uv-team-item-sub">
                  {[who, t.durationMs ? formatDuration(t.durationMs) : null, timeAgo(t.updatedAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {t.reportPreview && <div className="uv-team-item-sub">{t.reportPreview}</div>}
              </div>
            </Row>
          );
        })}
      </div>
    </motion.section>
  );
}

'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoveRight } from 'lucide-react';
import { toast } from 'sonner';
import '@/styles/operations/ventas.css';
import { describeSubmitOutcome, formatDueLabel } from '@/components/operations/mywork-model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Badge, Button } from '@/components/ui/primitives';
import { useOfflineCommandQueue } from '@/lib/hooks/use-offline-command-queue';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { PipelineStageDTO } from '@/modules/crm/crm-dto';
import type { PipelineBoard as PipelineBoardDTO } from '@/modules/crm/crm-queries';
import type { ConvertibleQuote } from '@/modules/areas/ventas/ventas-queries';
import {
  formatMoney,
  opportunityHref,
  quoteHref,
  VENTAS_API,
  ventasRadarHref,
} from '@/modules/areas/ventas/ventas-constants';
import {
  activeStageIds,
  boardColumns,
  boardTotals,
  buildCreateStageCommand,
  buildMoveStageCommand,
  buildReorderStagesCommand,
  buildUpdateStageCommand,
  deactivateStageIssue,
  lostReasonError,
  moveStageInOrder,
  moveTargets,
  openStageCounts,
  planStageMove,
  stageFormIssues,
  type PipelineCardView,
  type PipelineColumnView,
  type StageFormInput,
} from './pipeline-model';

/**
 * Embudo comercial por etapa (plan 7.4, subpágina de Ventas).
 *
 * Arrastrar una tarjeta a otra columna ejecuta el comando
 * `crm.opportunity.move_stage`; quien no use el ratón tiene la misma acción en
 * el menú "Mover a…" de cada tarjeta. Mover a una etapa perdida pide el motivo
 * y mover a la ganada confirma, igual que el motor exige.
 */

export interface PipelineBoardProps {
  userId: string;
  board: PipelineBoardDTO;
  /** Etapas ACTIVAS del embudo (las columnas del tablero). */
  stages: PipelineStageDTO[];
  /** Todas las etapas, incluidas las apagadas: sólo las ve quien las administra. */
  allStages?: PipelineStageDTO[];
  canManage: boolean;
  /** `crm.manage_stages`: crear, renombrar, reordenar y apagar etapas (plan 6.5). */
  canManageStages?: boolean;
  canCreateSalesOrder: boolean;
  /** Cotizaciones aceptadas que todavía no se convirtieron en orden de venta. */
  convertible: ConvertibleQuote[];
  /** Hora del servidor del render (las etiquetas de vencimiento no parpadean al hidratar). */
  nowIso: string;
}

type PendingMove = { card: PipelineCardView; stage: PipelineStageDTO; needsReason: boolean };

export function PipelineBoard({
  userId,
  board,
  stages,
  allStages,
  canManage,
  canManageStages = false,
  canCreateSalesOrder,
  convertible,
  nowIso,
}: PipelineBoardProps) {
  const router = useRouter();
  const { submit, online } = useOfflineCommandQueue(userId);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [stagesOpen, setStagesOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const columns = useMemo(() => boardColumns(board), [board]);
  const totals = useMemo(() => boardTotals(board), [board]);
  const cards = useMemo(() => columns.flatMap((column) => column.cards), [columns]);

  // dnd-kit numbers its accessibility ids from a module-level counter that does not
  // line up between the server render and the client one, so the generated
  // `aria-describedby` differed and React threw this whole subtree away and rebuilt
  // it on every load (hydration error #418). `useId` is stable across both.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const move = useCallback(
    async (card: PipelineCardView, stage: PipelineStageDTO, lostReason?: string) => {
      setBusyId(card.id);
      try {
        const outcome = await submit<Record<string, unknown>>(
          buildMoveStageCommand(card, stage, lostReason)
        );
        const feedback = describeSubmitOutcome(outcome, `${card.number} movida a ${stage.name}`);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh) router.refresh();
        return feedback.kind === 'success' || feedback.kind === 'queued';
      } finally {
        setBusyId(null);
      }
    },
    [router, submit]
  );

  const start = useCallback(
    (card: PipelineCardView, stage: PipelineStageDTO) => {
      const plan = planStageMove(card, stage);
      if (plan.kind === 'noop') {
        toast.info(plan.message);
        return;
      }
      if (plan.kind === 'needs_reason') {
        setPending({ card, stage: plan.stage, needsReason: true });
        return;
      }
      if (plan.confirm) {
        setPending({ card, stage: plan.stage, needsReason: false });
        return;
      }
      void move(card, stage);
    },
    [move]
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over) return;
      const card = cards.find((row) => row.id === String(event.active.id));
      const stage = stages.find((row) => row.id === String(event.over?.id));
      if (card && stage) start(card, stage);
    },
    [cards, stages, start]
  );

  return (
    <div className="area-space">
      <div className="ventas-toolbar">
        <p className="ventas-summary">
          <span>
            <strong>{totals.openLabel}</strong> oportunidades abiertas
          </span>
          <span>
            <strong>{totals.valueLabel}</strong> en el embudo
          </span>
          <span>
            <strong>{totals.weightedLabel}</strong> ponderado por probabilidad
          </span>
        </p>
        <div className="ventas-toolbar-spacer" />
        {canManageStages ? (
          <Button variant="secondary" size="sm" onClick={() => setStagesOpen(true)}>
            Etapas del embudo
          </Button>
        ) : null}
        <Link className="btn btn-secondary btn-sm" href={ventasRadarHref()}>
          Radar de cierre
        </Link>
      </div>

      {!canManage ? (
        <Alert variant="info">
          Puedes consultar el embudo. Para mover oportunidades de etapa necesitas el permiso de
          gestión del CRM.
        </Alert>
      ) : null}
      {!online ? (
        <Alert variant="warning">
          Sin conexión: los cambios de etapa se guardan y se envían al reconectar.
        </Alert>
      ) : null}

      <DndContext id={dndId} sensors={sensors} onDragEnd={onDragEnd}>
        <div className="ventas-board" role="list" aria-label="Embudo comercial por etapa">
          {columns.map((column) => (
            <StageColumn
              key={column.stageId}
              column={column}
              stages={stages}
              canManage={canManage}
              busyId={busyId}
              now={now}
              onMove={start}
            />
          ))}
        </div>
      </DndContext>

      <section className="ventas-panel" aria-labelledby="ventas-convertible">
        <h3 id="ventas-convertible" className="ventas-panel-title">
          Cotizaciones aceptadas por convertir
        </h3>
        {convertible.length === 0 ? (
          <p className="ventas-hint">
            No hay cotizaciones aceptadas pendientes de convertirse en orden de venta.
          </p>
        ) : (
          <ul className="ventas-list">
            {convertible.map((quote) => (
              <ConvertibleQuoteRow
                key={quote.quoteId}
                quote={quote}
                canCreateSalesOrder={canCreateSalesOrder}
                onDone={() => router.refresh()}
              />
            ))}
          </ul>
        )}
        {!canCreateSalesOrder ? (
          <p className="ventas-hint">
            Crear la orden en Zoho requiere el permiso «Crear órdenes de venta en Zoho». Si no lo
            tienes, pídelo en el copiloto del área: la IA deja la acción lista para que alguien con
            permiso la apruebe.
          </p>
        ) : null}
      </section>

      {pending ? (
        <MoveDialog
          pending={pending}
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            const done = await move(pending.card, pending.stage, reason);
            if (done) setPending(null);
          }}
        />
      ) : null}

      {stagesOpen && canManageStages ? (
        <StagesDialog
          userId={userId}
          stages={allStages ?? stages}
          openCounts={openStageCounts(board)}
          onClose={() => setStagesOpen(false)}
          onChanged={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Etapas del embudo (plan 6.5: `crm.manage_stages`)
// ---------------------------------------------------------------------------

const EMPTY_STAGE_FORM: StageFormInput = {
  name: '',
  kind: 'open',
  probabilityPct: '',
  slaHours: '',
};

/**
 * Administración del embudo: crear una etapa, renombrarla, cambiar su
 * probabilidad y su SLA, reordenarla y apagarla.
 *
 * Los tres comandos (`crm.stage.create | update | reorder`) existían desde el
 * principio con su permiso `crm.manage_stages`, pero NINGUNA pantalla los
 * invocaba: la única forma de tocar el embudo era POSTear a mano. El motor
 * vuelve a validar todo: nombre repetido, el embudo necesita una etapa activa
 * de cada tipo y una etapa con oportunidades vivas no se apaga.
 */
function StagesDialog({
  userId,
  stages,
  openCounts,
  onClose,
  onChanged,
}: {
  userId: string;
  stages: PipelineStageDTO[];
  openCounts: Record<string, number>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { submit, online } = useOfflineCommandQueue(userId);
  const [form, setForm] = useState<StageFormInput>(EMPTY_STAGE_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', probabilityPct: '', slaHours: '' });

  const sorted = useMemo(
    () => [...stages].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'es')),
    [stages]
  );
  const activeIds = useMemo(() => activeStageIds(stages), [stages]);

  const run = useCallback(
    async (command: OfflineCommandInput<Record<string, unknown>>, success: string) => {
      if (busy) return false;
      setBusy(true);
      try {
        const outcome = await submit<Record<string, unknown>>(command);
        const feedback = describeSubmitOutcome(outcome, success);
        if (feedback.kind === 'success') toast.success(feedback.message);
        else if (feedback.kind === 'queued') toast.info(feedback.message);
        else if (feedback.kind === 'conflict') toast.warning(feedback.message);
        else toast.error(feedback.message);
        if (feedback.refresh) onChanged();
        return feedback.kind === 'success' || feedback.kind === 'queued';
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'No se pudo enviar la acción');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged, submit]
  );

  async function createStage() {
    const issues = stageFormIssues(form, stages);
    if (issues.length > 0) {
      setErrors(issues);
      return;
    }
    setErrors([]);
    const done = await run(buildCreateStageCommand(form), `Etapa «${form.name.trim()}» creada`);
    if (done) setForm(EMPTY_STAGE_FORM);
  }

  async function saveStage(stage: PipelineStageDTO) {
    const issues = stageFormIssues(
      { ...draft, kind: stage.kind },
      stages.filter((row) => row.id !== stage.id)
    );
    if (issues.length > 0) {
      setErrors(issues);
      return;
    }
    setErrors([]);
    const done = await run(
      buildUpdateStageCommand({
        stageId: stage.id,
        name: draft.name,
        probabilityPct: draft.probabilityPct,
        slaHours: draft.slaHours.trim() === '' ? null : draft.slaHours,
      }),
      `Etapa «${draft.name.trim()}» actualizada`
    );
    if (done) setEditingId(null);
  }

  async function toggleStage(stage: PipelineStageDTO) {
    if (stage.active) {
      const issue = deactivateStageIssue(stages, stage.id, openCounts[stage.id] ?? 0);
      if (issue) {
        setErrors([issue]);
        return;
      }
    }
    setErrors([]);
    await run(
      buildUpdateStageCommand({ stageId: stage.id, active: !stage.active }),
      stage.active ? `Etapa «${stage.name}» apagada` : `Etapa «${stage.name}» reactivada`
    );
  }

  async function reorder(stageId: string, direction: 'up' | 'down') {
    const next = moveStageInOrder(activeIds, stageId, direction);
    if (next.join('|') === activeIds.join('|')) return;
    setErrors([]);
    await run(buildReorderStagesCommand(next), 'Nuevo orden del embudo guardado');
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Etapas del embudo</DialogTitle>
          <DialogDescription>
            El orden es el de las columnas del tablero. Una etapa nunca se borra: se apaga, y las
            oportunidades que pasaron por ella conservan su historia.
          </DialogDescription>
        </DialogHeader>

        {!online ? (
          <Alert variant="warning">
            Sin conexión: los cambios del embudo se guardan y se envían al reconectar.
          </Alert>
        ) : null}
        {errors.length > 0 ? (
          <Alert variant="error" title="Revisa esto">
            <ul>
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <ul className="ventas-list" aria-label="Etapas del embudo">
          {sorted.map((stage, index) => {
            const isEditing = editingId === stage.id;
            const activeIndex = activeIds.indexOf(stage.id);
            return (
              <li key={stage.id} className="ventas-list-row">
                <div className="ventas-list-main">
                  <strong>
                    {index + 1}. {stage.name}
                  </strong>
                  <span className="ventas-hint">
                    {stage.kind === 'won'
                      ? 'Ganada'
                      : stage.kind === 'lost'
                        ? 'Perdida'
                        : 'Abierta'}{' '}
                    · {Math.round(stage.probabilityDefault * 100)} % ·{' '}
                    {stage.slaHours ? `SLA ${stage.slaHours} h` : 'sin SLA'}
                    {stage.active ? '' : ' · apagada'}
                  </span>
                  {isEditing ? (
                    <div className="ventas-form">
                      <label className="form-label" htmlFor={`stage-name-${stage.id}`}>
                        Nombre
                      </label>
                      <input
                        id={`stage-name-${stage.id}`}
                        className="input"
                        maxLength={60}
                        value={draft.name}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      />
                      <label className="form-label" htmlFor={`stage-prob-${stage.id}`}>
                        Probabilidad por omisión (%)
                      </label>
                      <input
                        id={`stage-prob-${stage.id}`}
                        className="input"
                        inputMode="numeric"
                        value={draft.probabilityPct}
                        onChange={(event) =>
                          setDraft({ ...draft, probabilityPct: event.target.value })
                        }
                      />
                      <label className="form-label" htmlFor={`stage-sla-${stage.id}`}>
                        SLA en horas (vacío = sin SLA)
                      </label>
                      <input
                        id={`stage-sla-${stage.id}`}
                        className="input"
                        inputMode="numeric"
                        value={draft.slaHours}
                        onChange={(event) => setDraft({ ...draft, slaHours: event.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
                <div className="ventas-list-actions">
                  {isEditing ? (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => saveStage(stage)}
                      >
                        Guardar
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        Cancelar
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setErrors([]);
                          setEditingId(stage.id);
                          setDraft({
                            name: stage.name,
                            probabilityPct: String(Math.round(stage.probabilityDefault * 100)),
                            slaHours: stage.slaHours === null ? '' : String(stage.slaHours),
                          });
                        }}
                      >
                        Editar
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || activeIndex <= 0}
                        aria-label={`Subir ${stage.name}`}
                        onClick={() => reorder(stage.id, 'up')}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || activeIndex < 0 || activeIndex >= activeIds.length - 1}
                        aria-label={`Bajar ${stage.name}`}
                        onClick={() => reorder(stage.id, 'down')}
                      >
                        ↓
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => toggleStage(stage)}
                      >
                        {stage.active ? 'Apagar' : 'Reactivar'}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="ventas-form">
          <h4 className="ventas-panel-title">Nueva etapa</h4>
          <label className="form-label" htmlFor="stage-new-name">
            Nombre
          </label>
          <input
            id="stage-new-name"
            className="input"
            maxLength={60}
            value={form.name}
            placeholder="Visita técnica"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <label className="form-label" htmlFor="stage-new-kind">
            Tipo
          </label>
          <select
            id="stage-new-kind"
            className="input"
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value })}
          >
            <option value="open">Abierta (va antes del cierre)</option>
            <option value="won">Ganada</option>
            <option value="lost">Perdida</option>
          </select>
          <label className="form-label" htmlFor="stage-new-prob">
            Probabilidad por omisión (%) — vacío usa la del tipo
          </label>
          <input
            id="stage-new-prob"
            className="input"
            inputMode="numeric"
            value={form.probabilityPct}
            onChange={(event) => setForm({ ...form, probabilityPct: event.target.value })}
          />
          <label className="form-label" htmlFor="stage-new-sla">
            SLA en horas — vacío deja la etapa sin SLA
          </label>
          <input
            id="stage-new-sla"
            className="input"
            inputMode="numeric"
            value={form.slaHours}
            onChange={(event) => setForm({ ...form, slaHours: event.target.value })}
          />
        </div>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
          <Button variant="primary" size="sm" onClick={createStage} disabled={busy}>
            {busy ? 'Enviando…' : 'Crear etapa'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Columna y tarjeta
// ---------------------------------------------------------------------------

interface StageColumnProps {
  column: PipelineColumnView;
  stages: PipelineStageDTO[];
  canManage: boolean;
  busyId: string | null;
  now: Date;
  onMove: (card: PipelineCardView, stage: PipelineStageDTO) => void;
}

function StageColumn({ column, stages, canManage, busyId, now, onMove }: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stageId, disabled: !canManage });
  return (
    <section
      ref={setNodeRef}
      className={`ventas-board-column ${isOver ? 'ventas-board-column-over' : ''}`}
      role="listitem"
      aria-label={`${column.stageName}: ${column.count} oportunidades`}
    >
      <header className="ventas-board-head">
        <h3 className="ventas-board-title">
          {column.stageName}
          {column.tone === 'success' ? <Badge variant="success">Ganado</Badge> : null}
          {column.tone === 'danger' ? <Badge variant="danger">Perdido</Badge> : null}
        </h3>
        <span className="ventas-board-meta">
          {column.count} · {column.totalLabel}
          {column.stageKind === 'open' ? ` · ${column.weightedLabel} ponderado` : ''}
        </span>
      </header>

      {column.cards.length === 0 ? (
        <p className="ventas-hint">Sin oportunidades en esta etapa.</p>
      ) : (
        <ul className="ventas-board-cards">
          {column.cards.map((card) => (
            <OpportunityCard
              key={card.id}
              card={card}
              stages={stages}
              canManage={canManage}
              busy={busyId === card.id}
              now={now}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface OpportunityCardProps {
  card: PipelineCardView;
  stages: PipelineStageDTO[];
  canManage: boolean;
  busy: boolean;
  now: Date;
  onMove: (card: PipelineCardView, stage: PipelineStageDTO) => void;
}

function OpportunityCard({ card, stages, canManage, busy, now, onMove }: OpportunityCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: !canManage,
  });
  const due = card.nextActionAt ? formatDueLabel(card.nextActionAt, now) : null;
  const dueClass =
    due?.tone === 'danger'
      ? 'ventas-card-due-danger'
      : due?.tone === 'warning'
        ? 'ventas-card-due-warning'
        : '';
  const targets = moveTargets(stages, card.stageId);

  return (
    <li
      ref={setNodeRef}
      className={`ventas-card ${isDragging ? 'ventas-card-dragging' : ''}`}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
    >
      <div className="ventas-card-head">
        {canManage ? (
          <button
            type="button"
            className="ventas-card-grip"
            aria-label={`Arrastrar ${card.number} a otra etapa`}
            title="Arrastrar a otra etapa"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
        ) : null}
        <Link className="ventas-card-title" href={opportunityHref(card.id)}>
          {card.title}
        </Link>
      </div>
      <span className="ventas-card-number">
        {card.number} · {card.customerName}
      </span>
      <div className="ventas-card-line">
        <span>{card.valueLabel}</span>
        <span>{card.probabilityLabel}</span>
        {card.salespersonName ? <span>{card.salespersonName}</span> : null}
      </div>
      {due ? (
        <div className="ventas-card-line">
          <span className={dueClass} title={due.title}>
            {card.nextActionText ? `${card.nextActionText} · ${due.label}` : due.label}
          </span>
        </div>
      ) : (
        <div className="ventas-card-line">
          <span className="ventas-muted">Sin siguiente acción</span>
        </div>
      )}
      {card.stageSlaExceededHours !== null ? (
        <div className="ventas-card-line">
          <Badge variant="warning">{card.stageSlaExceededHours} h sobre el SLA</Badge>
        </div>
      ) : null}

      {canManage && targets.length > 0 ? (
        <div className="ventas-card-line">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-label={`Mover ${card.number} a otra etapa`}
              >
                <MoveRight size={14} aria-hidden="true" />
                {busy ? 'Moviendo…' : 'Mover a…'}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Mover a</DropdownMenuLabel>
              {targets.map((stage) => (
                <DropdownMenuItem key={stage.id} onSelect={() => onMove(card, stage)}>
                  {stage.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Diálogo del movimiento
// ---------------------------------------------------------------------------

function MoveDialog({
  pending,
  onClose,
  onConfirm,
}: {
  pending: PendingMove;
  onClose: () => void;
  onConfirm: (reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (busy) return;
    if (pending.needsReason) {
      const invalid = lostReasonError(reason);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    setError(null);
    setBusy(true);
    try {
      await onConfirm(pending.needsReason ? reason : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {pending.needsReason
              ? `Marcar ${pending.card.number} como perdida`
              : `Mover ${pending.card.number} a ${pending.stage.name}`}
          </DialogTitle>
          <DialogDescription>
            {pending.needsReason
              ? 'El motivo queda en la línea de tiempo de la oportunidad y alimenta el análisis comercial.'
              : 'La oportunidad se marcará como ganada y quedará registrada con la fecha de hoy.'}
          </DialogDescription>
        </DialogHeader>

        {pending.needsReason ? (
          <div className="ventas-form">
            <label className="form-label" htmlFor="pipeline-lost-reason">
              Motivo de la pérdida
            </label>
            <textarea
              id="pipeline-lost-reason"
              className="input"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Precio, tiempo de entrega, se fue con la competencia…"
            />
          </div>
        ) : null}

        {error ? <p className="ventas-form-error">{error}</p> : null}

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={pending.needsReason ? 'danger' : 'primary'}
            size="sm"
            onClick={send}
            disabled={busy}
          >
            {busy ? 'Enviando…' : pending.needsReason ? 'Marcar perdida' : 'Confirmar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Cotización aceptada → orden de venta en Zoho
// ---------------------------------------------------------------------------

function ConvertibleQuoteRow({
  quote,
  canCreateSalesOrder,
  onDone,
}: {
  quote: ConvertibleQuote;
  canCreateSalesOrder: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function convert() {
    setBusy(true);
    try {
      const response = await fetch(VENTAS_API.quoteSalesOrder(quote.quoteId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(quote.opportunityId ? { opportunityId: quote.opportunityId } : {}),
      });
      const json = (await response.json().catch(() => ({}))) as {
        result?: { salesOrderNumber: string | null; mock: boolean; replayed: boolean };
        error?: string;
      };
      if (!response.ok || !json.result) {
        throw new Error(json.error ?? 'No se pudo crear la orden de venta');
      }
      const folio = json.result.salesOrderNumber ?? 'nueva orden';
      toast.success(
        json.result.replayed
          ? `Esta cotización ya tenía la orden ${folio}`
          : `Orden ${folio} creada en Zoho${json.result.mock ? ' (modo simulado)' : ''}`
      );
      setConfirming(false);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo crear la orden de venta');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="ventas-list-item">
      <Link href={quoteHref(quote.quoteId)}>
        <strong>{quote.estimateNumber}</strong>
      </Link>
      <span>{quote.customerName ?? 'Sin cliente'}</span>
      <span>{formatMoney(quote.total, quote.currencyCode ?? 'MXN')}</span>
      {quote.opportunityNumber ? (
        <Link href={opportunityHref(quote.opportunityId as string)}>{quote.opportunityNumber}</Link>
      ) : (
        <span className="ventas-muted">Sin oportunidad ligada</span>
      )}
      <div className="ventas-toolbar-spacer" />
      {canCreateSalesOrder ? (
        confirming ? (
          <>
            <Button variant="primary" size="sm" onClick={convert} disabled={busy}>
              {busy ? 'Creando…' : 'Sí, crear en Zoho'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancelar
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Crear OV en Zoho
          </Button>
        )
      ) : null}
    </li>
  );
}

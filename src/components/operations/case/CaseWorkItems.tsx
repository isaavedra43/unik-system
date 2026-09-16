'use client';

import Link from 'next/link';
import { AlertTriangle, MoreHorizontal, Paperclip } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { Badge, Button } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  COMPLETE_NOTE_MAX,
  ESCALATE_NOTE_MAX,
  WAIT_REASON_MAX,
  WORK_ITEM_STATUS_BADGE,
  buildCompletePayload,
  buildEscalatePayload,
  buildWaitPayload,
  evidenceLabel,
  formatDueLabel,
  isRequestWorkItem,
} from '@/components/operations/mywork-model';
import {
  CASE_WORK_ITEM_ACTION_LABELS,
  CASE_WORK_ITEM_ACTION_SUCCESS,
  REASSIGN_REASON_MAX,
  buildCaseWorkItemCommand,
  buildReassignPayload,
  caseWorkItemActions,
  needsEvidenceElsewhere,
  type CaseWorkItemAction,
  type CaseWorkItemView,
} from './case-model';
import type { CasePendingAction } from './CaseActionDialog';

export interface CaseWorkItemsProps {
  caseId: string;
  items: CaseWorkItemView[];
  now: Date;
  /** Raises an action that needs a form; the page owns the single dialog. */
  onAction: (pending: CasePendingAction) => void;
  /** Runs an action that needs no form ("Iniciar"). */
  onRun: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

/**
 * Open work of the case with the actions the engine would accept (plan 2.7).
 * The four actions of "Mi trabajo" come from the shared model plus "Reasignar
 * responsable"; completing a work item whose evidence is still missing is sent
 * to "Mi trabajo", where the uploader lives, instead of failing here.
 */
export function CaseWorkItems({ caseId, items, now, onAction, onRun }: CaseWorkItemsProps) {
  function pendingFor(
    action: CaseWorkItemAction,
    item: CaseWorkItemView
  ): CasePendingAction | null {
    const base = {
      key: `${item.id}-${action}`,
      title: CASE_WORK_ITEM_ACTION_LABELS[action],
      subject: item.title,
      successMessage: CASE_WORK_ITEM_ACTION_SUCCESS[action],
      command: (payload: Record<string, unknown>) =>
        buildCaseWorkItemCommand(action, item, payload),
    };
    switch (action) {
      case 'start':
        return null;
      case 'complete':
        return {
          ...base,
          form: 'note',
          tone: 'primary',
          maxLength: COMPLETE_NOTE_MAX,
          required: isRequestWorkItem(item),
          hint: isRequestWorkItem(item)
            ? 'Escribe la respuesta para el área que hizo la solicitud.'
            : 'Agrega la nota que deja constancia de lo que hiciste.',
          build: ({ text }) => buildCompletePayload({ objectType: item.objectType }, text),
        };
      case 'wait':
        return {
          ...base,
          form: 'wait',
          tone: 'primary',
          maxLength: WAIT_REASON_MAX,
          required: true,
          hint: 'Di de qué depende y hasta cuándo esperas.',
          build: ({ text, until }) => buildWaitPayload(text, until, now),
        };
      case 'escalate':
        return {
          ...base,
          form: 'note',
          tone: 'primary',
          maxLength: ESCALATE_NOTE_MAX,
          hint: 'Explica por qué necesitas ayuda; avisamos al siguiente nivel.',
          build: ({ text }) => buildEscalatePayload(text),
        };
      case 'reassign':
      default:
        return {
          ...base,
          form: 'reassign',
          tone: 'primary',
          maxLength: REASSIGN_REASON_MAX,
          hint: 'La persona que lo reciba verá el trabajo en "Mi trabajo" con su vencimiento.',
          assigneesUrl: `/app/operations/api/cases/${encodeURIComponent(caseId)}/assignees`,
          currentOwnerUserId: item.ownerUserId,
          build: ({ ownerUserId, text }) => buildReassignPayload({ ownerUserId, reason: text }),
        };
    }
  }

  async function run(action: CaseWorkItemAction, item: CaseWorkItemView) {
    const pending = pendingFor(action, item);
    if (pending) {
      onAction(pending);
      return;
    }
    await onRun(buildCaseWorkItemCommand(action, item), CASE_WORK_ITEM_ACTION_SUCCESS[action]);
  }

  if (items.length === 0) {
    return (
      <div className="case-empty">
        <strong>Sin trabajos abiertos</strong>
        <p>Nadie tiene tareas pendientes de este expediente en este momento.</p>
      </div>
    );
  }

  return (
    <ul className="case-list">
      {items.map((item) => {
        const actions = caseWorkItemActions(item);
        const [primary, ...rest] = actions;
        const due = formatDueLabel(item.dueAt, now);
        const badge = WORK_ITEM_STATUS_BADGE[item.status] ?? 'default';
        return (
          <li key={item.id} className={`case-item ${item.overdue ? 'case-item-alert' : ''}`.trim()}>
            <div className="case-item-main">
              <span className="case-item-title">{item.title}</span>
              <span className="case-item-meta">
                <Badge variant={badge}>{item.statusLabel}</Badge>
                <span>{item.areaLabel}</span>
                <span>{item.ownerName ?? 'Sin asignar'}</span>
                <span
                  className={
                    due.tone === 'danger'
                      ? 'case-due-danger'
                      : due.tone === 'warning'
                        ? 'case-due-warning'
                        : ''
                  }
                  title={due.title}
                >
                  {due.label}
                </span>
                {item.escalationLevel > 0 ? (
                  <span>Escalado nivel {item.escalationLevel}</span>
                ) : null}
              </span>
              {item.waitReason ? (
                <span className="case-item-meta">En espera: {item.waitReason}</span>
              ) : null}
              {needsEvidenceElsewhere(item) ? (
                <span className="case-item-meta">
                  <AlertTriangle size={14} aria-hidden="true" />
                  Falta {item.missingEvidence.map((key) => evidenceLabel(key)).join(', ')}
                </span>
              ) : null}
            </div>

            <div className="case-item-actions">
              {needsEvidenceElsewhere(item) ? (
                <Link className="btn btn-secondary btn-sm" href={`/app/mywork?workItem=${item.id}`}>
                  <Paperclip size={14} aria-hidden="true" />
                  Completar en Mi trabajo
                </Link>
              ) : null}
              {primary ? (
                <Button variant="primary" size="sm" onClick={() => void run(primary, item)}>
                  {CASE_WORK_ITEM_ACTION_LABELS[primary]}
                </Button>
              ) : null}
              {rest.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Más acciones de ${item.title}`}
                      title="Más acciones"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {rest.map((action) => (
                      <DropdownMenuItem key={action} onSelect={() => void run(action, item)}>
                        {CASE_WORK_ITEM_ACTION_LABELS[action]}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {actions.length === 0 && !needsEvidenceElsewhere(item) ? (
                <span className="case-item-meta">
                  Sólo su responsable o un gestor puede moverlo
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

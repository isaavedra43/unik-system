import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import { rowKindPluralLabel } from '@/modules/areas/area-work-row';
import type { AreaRowAction } from '@/modules/areas/work-actions';
// Desde `area-links` (puro) y no desde `work-filters`, que re-exporta lo mismo:
// este archivo lo consume un componente de cliente y `work-filters` trae zod.
import { areaWorkChipParams } from '@/modules/areas/area-links';
import type { AreaWorkQueryState, AreaWorkScope } from '@/modules/areas/work-filters';

/**
 * Pure view model of the area work centre (plan 7.4 / 7.2): the chips of the
 * toolbar, the context the copilot receives on every turn and the payload each
 * row action sends. No React and no I/O, so it is unit tested on its own.
 *
 * Date labels and command outcomes are REUSED from "Mi trabajo"
 * (`@/components/operations/mywork-model`); nothing is duplicated here.
 */

/** Rows summarized for the copilot (plan 7.2: ≤25 rows, ≤50 selected ids). */
export const AREA_CONTEXT_ROWS = 25;
export const AREA_CONTEXT_SELECTION = 50;

const clip = (value: string | null, max: number): string | null =>
  value === null ? null : value.length > max ? `${value.slice(0, max - 1)}…` : value;

export interface AreaCopilotContextInput {
  areaKey: string;
  rows: readonly AreaWorkRow[];
  total: number;
  query: AreaWorkQueryState;
  selectedIds: readonly string[];
  spaceSlug?: string;
}

/**
 * Visible table sent as DATA on every copilot turn (the route forwards it as
 * `tableContext`, which the orchestrator bounds and wraps as untrusted).
 */
export function buildAreaCopilotContext(input: AreaCopilotContextInput): Record<string, unknown> {
  const { query } = input;
  return {
    surface: 'area',
    areaKey: input.areaKey,
    space: input.spaceSlug ?? 'trabajo',
    query: {
      search: query.search?.trim() || null,
      scope: query.scope,
      kinds: query.kind,
      overdueOnly: query.overdueOnly,
      onlyMine: Boolean(query.ownerUserId),
      caseId: query.caseId ?? null,
      filters: query.filters.rules.length,
      page: query.page,
    },
    total: input.total,
    visible: Math.min(input.rows.length, AREA_CONTEXT_ROWS),
    overdue: input.rows.filter((row) => row.overdue).length,
    selectedIds: input.selectedIds.slice(0, AREA_CONTEXT_SELECTION),
    rows: input.rows.slice(0, AREA_CONTEXT_ROWS).map((row) => ({
      id: row.id,
      rowKind: row.rowKind,
      title: clip(row.title, 120),
      status: row.status,
      statusLabel: row.statusLabel,
      dueAt: row.dueAt,
      overdue: row.overdue,
      ownerName: clip(row.ownerName, 60),
      caseNumber: row.caseNumber,
      customerName: clip(row.customerName, 80),
    })),
  };
}

/** Newest activity of the visible rows: drives the copilot's "inbound" re-analysis. */
export function areaActivityAt(rows: readonly AreaWorkRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (!latest || Date.parse(row.lastActivityAt) > Date.parse(latest)) latest = row.lastActivityAt;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Toolbar chips
// ---------------------------------------------------------------------------

export interface AreaChip {
  id: string;
  label: string;
  href: string;
  active: boolean;
  /** Assistive description when the label alone is not enough. */
  title?: string;
}

export interface AreaChipsInput {
  basePath: string;
  rowKinds: readonly string[];
  current: {
    kind: string | null;
    scope: AreaWorkScope;
    mine: boolean;
    overdue: boolean;
  };
}

/**
 * Href of a chip: the base path plus the state the chip leaves behind.
 *
 * The params are built by `areaWorkChipParams` (`work-filters.ts`), the same
 * module whose `areaWorkQueryFromSearchParams` reads them back on the server.
 * Spelling them here too used to mean two copies of the names `kind`, `scope`,
 * `mios` and `vencidos`, and a chip that could quietly stop agreeing with the
 * parser; now there is one.
 */
function chipHref(
  basePath: string,
  current: AreaChipsInput['current'],
  patch: Partial<AreaChipsInput['current']>
): string {
  const query = areaWorkChipParams(current, patch).toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** Row-kind chips: "Todo" plus one per kind the area actually has a branch for. */
export function rowKindChips(input: AreaChipsInput): AreaChip[] {
  const { basePath, current } = input;
  return [
    {
      id: 'all',
      label: 'Todo',
      href: chipHref(basePath, current, { kind: null }),
      active: !current.kind || current.kind === 'all',
    },
    ...input.rowKinds.map((kind) => ({
      id: kind,
      label: rowKindPluralLabel(kind),
      href: chipHref(basePath, current, { kind }),
      active: current.kind === kind,
    })),
  ];
}

/** Scope and focus chips: open / closed / all, only mine, only overdue. */
export function scopeChips(input: AreaChipsInput): AreaChip[] {
  const { basePath, current } = input;
  return [
    {
      id: 'open',
      label: 'Abiertos',
      href: chipHref(basePath, current, { scope: 'open' }),
      active: current.scope === 'open',
    },
    {
      id: 'closed',
      label: 'Cerrados',
      href: chipHref(basePath, current, { scope: 'closed' }),
      active: current.scope === 'closed',
    },
    {
      id: 'all',
      label: 'Todos',
      href: chipHref(basePath, current, { scope: 'all' }),
      active: current.scope === 'all',
    },
    {
      id: 'mine',
      label: 'Míos',
      href: chipHref(basePath, current, { mine: !current.mine }),
      active: current.mine,
      title: 'Sólo lo que tengo a cargo o cubro como suplente',
    },
    {
      id: 'overdue',
      label: 'Vencidos',
      href: chipHref(basePath, current, { overdue: !current.overdue }),
      active: current.overdue,
      title: 'Sólo lo que ya pasó su fecha',
    },
  ];
}

// ---------------------------------------------------------------------------
// Action payloads
// ---------------------------------------------------------------------------

export const REASON_MIN = 3;
export const REASON_MAX = 1000;
export const ANSWER_MAX = 4000;
export const NOTE_MAX = 2000;

export type PayloadCheck =
  { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

export interface ActionFormValues {
  /** `note`, `reason` and `answer` share the same textarea. */
  text: string;
  /** `wait`: value of a datetime-local input (browser time zone). */
  until?: string;
}

/**
 * Renames the text the dialog collected when the command does not call it
 * `note` / `reason` / `answer` (`payloadTextKey`: `lostReason`, `summary`…).
 * The wait period keeps `until`, which every command spells the same.
 */
function withTextKey(
  action: AreaRowAction,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const key = action.payloadTextKey;
  if (!key) return payload;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(payload)) {
    out[name === 'note' || name === 'reason' || name === 'answer' ? key : name] = value;
  }
  return out;
}

/**
 * Payload of a row action, validated with the SAME rules the engine applies
 * (`work-items-service` and `area-requests-service` schemas), so a person never
 * sends a command that will bounce back.
 */
export function buildActionPayload(
  action: AreaRowAction,
  values: ActionFormValues,
  now: Date
): PayloadCheck {
  const checked = buildFormPayload(action, values, now);
  return checked.ok ? { ok: true, payload: withTextKey(action, checked.payload) } : checked;
}

/** The same check, before the branch renames the text field. */
function buildFormPayload(
  action: AreaRowAction,
  values: ActionFormValues,
  now: Date
): PayloadCheck {
  const text = values.text.trim();
  switch (action.form) {
    case 'none':
      return { ok: true, payload: {} };
    case 'note':
      if (text.length > NOTE_MAX)
        return { ok: false, error: 'La nota admite hasta 2000 caracteres' };
      return { ok: true, payload: text ? { note: text } : {} };
    case 'reason':
      if (text.length < REASON_MIN)
        return { ok: false, error: 'Indica el motivo (mínimo 3 caracteres)' };
      if (text.length > REASON_MAX)
        return { ok: false, error: 'El motivo admite hasta 1000 caracteres' };
      return { ok: true, payload: { reason: text } };
    case 'answer':
      if (!text)
        return { ok: false, error: 'Escribe la respuesta para el área que envió la solicitud' };
      if (text.length > ANSWER_MAX)
        return { ok: false, error: 'La respuesta admite hasta 4000 caracteres' };
      return { ok: true, payload: { answer: text } };
    case 'wait': {
      if (text.length < REASON_MIN)
        return { ok: false, error: 'Indica el motivo de la espera (mínimo 3 caracteres)' };
      if (text.length > 500) return { ok: false, error: 'El motivo admite hasta 500 caracteres' };
      if (!values.until?.trim()) return { ok: true, payload: { reason: text } };
      const until = new Date(values.until);
      if (Number.isNaN(until.getTime()))
        return { ok: false, error: 'La fecha de fin de la espera no es válida' };
      if (until.getTime() <= now.getTime())
        return { ok: false, error: 'La espera debe terminar en el futuro' };
      return { ok: true, payload: { reason: text, until: until.toISOString() } };
    }
    default:
      return { ok: true, payload: {} };
  }
}

/** Command sent to `POST /app/operations/api/commands` (or queued while offline). */
export function buildRowCommand(
  action: AreaRowAction,
  row: AreaWorkRow,
  payload: Record<string, unknown>
): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: action.commandType,
    // A domain action may act on another aggregate (an operation on its order)
    // and may carry the fixed payload its command requires.
    aggregate: { type: action.aggregateType, id: action.aggregateId ?? row.sourceId },
    payload: action.payload ? { ...action.payload, ...payload } : payload,
    expectedVersion: row.version,
  };
}

/** Label of the textarea of each form. */
export function actionFieldLabel(form: AreaRowAction['form']): string {
  switch (form) {
    case 'reason':
      return 'Motivo';
    case 'answer':
      return 'Respuesta';
    case 'wait':
      return 'Motivo de la espera';
    default:
      return 'Nota';
  }
}

/** True when the textarea cannot be left empty. */
export function actionFieldRequired(form: AreaRowAction['form']): boolean {
  return form === 'reason' || form === 'answer' || form === 'wait';
}

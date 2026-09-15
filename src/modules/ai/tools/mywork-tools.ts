import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { formatDueLabel } from '@/modules/agents/templates';
import { COUNT_OPEN_STATUSES } from '@/modules/inventory/inventory-types';
import { StockMathError, normalizeUnit, toBase, type UnitProfile } from '@/modules/inventory/stock-math';
import {
  APPROVAL_SCOPE_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  WORK_ITEM_OPEN_STATUSES,
  type ApprovalScope,
} from '@/modules/operations/types';
import type { WorkItemDTO } from '@/modules/operations/work-items-service';
import type { PendingApprovalDTO } from '@/modules/operations/approvals-service';
import {
  OperationsToolError,
  actorHas,
  areaName,
  assertActingScope,
  checkActingScope,
  formatMoney,
  isBotActor,
  loadOperationsCommands,
  registerOperationsTool,
  transitionCommandId,
  truncateText,
  unwrapCommand,
} from './operations-tool-kit';

/**
 * Tools of "Mi trabajo" (plan 5.5): what to do first, start one's own work and
 * record a physical count said in natural language. `myNextActions` only lives
 * in the mywork surface (orchestrator constant); `startWorkItem` and
 * `recordCount` are pinned there.
 */

const idArg = z.string().trim().min(1).max(120);

// ---------------------------------------------------------------------------
// myNextActions
// ---------------------------------------------------------------------------

export interface NextActionRequest {
  id: string;
  title: string;
  dueAt: Date;
  status: string;
  fromAreaKey: string;
  blocksDelivery: boolean;
  priority: string;
  caseId: string;
  workItemId: string | null;
}

export interface NextAction {
  kind: 'work_item' | 'approval' | 'request';
  id: string;
  title: string;
  reason: string;
  dueAt: string | null;
  overdue: boolean;
  caseNumber: string | null;
  suggestedTool: string | null;
  score: number;
}

type RankWorkItem = Pick<
  WorkItemDTO,
  'id' | 'title' | 'status' | 'kind' | 'dueAt' | 'overdue' | 'caseNumber' | 'escalationLevel' | 'objectType' | 'objectId'
>;
type RankApproval = Pick<
  PendingApprovalDTO,
  'id' | 'scope' | 'amount' | 'currency' | 'requiredApprovals' | 'approvals' | 'expiresAt' | 'createdAt' | 'caseId'
>;

const MINUTE = 60_000;
const DEFAULT_APPROVAL_SLA_MINUTES = 240;

function priorityBoost(priority: string): number {
  if (priority === 'urgent') return 600;
  if (priority === 'high') return 240;
  return 0;
}

/**
 * Orders the pending work of a person (pure). Lower score = do first: minutes
 * until due (negative when overdue) minus boosts for priority, delivery blocks
 * and escalations. A work item linked to a listed request or approval is shown
 * once, as the request or approval.
 */
export function rankNextActions(
  input: {
    workItems: RankWorkItem[];
    approvals: RankApproval[];
    requests: NextActionRequest[];
    caseNumbers?: ReadonlyMap<string, string>;
    now: Date;
  },
  limit = 8
): NextAction[] {
  const now = input.now.getTime();
  const requestIds = new Set(input.requests.map((r) => r.id));
  const approvalIds = new Set(input.approvals.map((a) => a.id));
  const actions: NextAction[] = [];

  for (const item of input.workItems) {
    if (item.objectType === 'area_request' && item.objectId && requestIds.has(item.objectId)) continue;
    if (item.objectType === 'approval_request' && item.objectId && approvalIds.has(item.objectId)) continue;
    const due = new Date(item.dueAt);
    const extras = [
      item.escalationLevel > 0 ? `escalado nivel ${item.escalationLevel + 1}` : null,
      item.status === 'waiting' ? 'en espera' : null,
    ].filter(Boolean);
    const suggestedTool =
      item.kind === 'verification'
        ? 'recordCount'
        : item.status === 'in_progress'
          ? 'completeWorkItem'
          : 'startWorkItem';
    actions.push({
      kind: 'work_item',
      id: item.id,
      title: item.title,
      reason: [`${item.overdue ? 'Venció' : 'Vence'} ${formatDueLabel(due, input.now)}`, ...extras].join(' · '),
      dueAt: due.toISOString(),
      overdue: item.overdue,
      caseNumber: item.caseNumber,
      suggestedTool,
      score: (due.getTime() - now) / MINUTE - item.escalationLevel * 120,
    });
  }

  for (const request of input.requests) {
    const overdue = request.dueAt.getTime() < now;
    const extras = [request.blocksDelivery ? 'bloquea la entrega' : null, request.status === 'blocked' ? 'la bloqueaste' : null].filter(Boolean);
    actions.push({
      kind: 'request',
      id: request.id,
      title: `Solicitud de ${areaName(request.fromAreaKey)}: ${request.title}`,
      reason: [`${overdue ? 'Venció' : 'Vence'} ${formatDueLabel(request.dueAt, input.now)}`, ...extras].join(' · '),
      dueAt: request.dueAt.toISOString(),
      overdue,
      caseNumber: input.caseNumbers?.get(request.caseId) ?? null,
      suggestedTool: 'respondAreaRequest',
      score:
        (request.dueAt.getTime() - now) / MINUTE - priorityBoost(request.priority) - (request.blocksDelivery ? 240 : 0),
    });
  }

  for (const approval of input.approvals) {
    const created = new Date(approval.createdAt).getTime();
    const due = approval.expiresAt ? new Date(approval.expiresAt).getTime() : created + DEFAULT_APPROVAL_SLA_MINUTES * MINUTE;
    const overdue = due < now;
    const scopeLabel = APPROVAL_SCOPE_LABELS[approval.scope as ApprovalScope] ?? approval.scope;
    actions.push({
      kind: 'approval',
      id: approval.id,
      title: `Aprobar ${scopeLabel.toLowerCase()} por ${formatMoney(approval.amount, approval.currency)}`,
      reason: `${approval.approvals} de ${approval.requiredApprovals} firma(s)${approval.expiresAt ? ` · ${overdue ? 'expiró' : 'expira'} ${formatDueLabel(approval.expiresAt, input.now)}` : ''}`,
      dueAt: new Date(due).toISOString(),
      overdue,
      caseNumber: approval.caseId ? (input.caseNumbers?.get(approval.caseId) ?? null) : null,
      suggestedTool: approval.scope === 'payment' ? 'authorizePayment' : null,
      score: (due - now) / MINUTE,
    });
  }

  return actions
    .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, limit))
    .map((action) => ({ ...action, score: Math.round(action.score) }));
}

registerOperationsTool({
  name: 'myNextActions',
  description:
    'Qué te toca hacer primero: tus trabajos abiertos, las solicitudes donde eres responsable y las aprobaciones que puedes decidir, ordenados por urgencia, con la herramienta sugerida para cada uno.',
  requiredPermission: 'assistant.use',
  effect: 'read',
  parameters: z.object({
    limit: z.number().int().min(1).max(20).describe('Cuántas acciones mostrar').default(8),
  }),
  execute: async (actor, raw) => {
    const args = raw as { limit: number };
    const now = new Date();
    const [{ listMyWorkItems }, { listPendingApprovals }] = await Promise.all([
      import('@/modules/operations/work-items-service'),
      import('@/modules/operations/approvals-service'),
    ]);
    const [page, approvals, requests] = await Promise.all([
      listMyWorkItems(actor, { scope: 'open', limit: 100 }, { now }),
      listPendingApprovals(actor, { limit: 50, now }),
      prisma.areaRequest.findMany({
        where: {
          status: { in: [...AREA_REQUEST_OPEN_STATUSES] },
          OR: [{ ownerUserId: actor.id }, { backupUserId: actor.id }],
        },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 50,
        select: {
          id: true,
          title: true,
          dueAt: true,
          status: true,
          fromAreaKey: true,
          blocksDelivery: true,
          priority: true,
          caseId: true,
          workItemId: true,
        },
      }),
    ]);
    const caseIds = [
      ...new Set([...requests.map((r) => r.caseId), ...approvals.map((a) => a.caseId)].filter((id): id is string => Boolean(id))),
    ];
    const cases = caseIds.length
      ? await prisma.operationalCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, caseNumber: true } })
      : [];
    const actions = rankNextActions(
      {
        workItems: page.items,
        approvals,
        requests,
        caseNumbers: new Map(cases.map((c) => [c.id, c.caseNumber])),
        now,
      },
      args.limit
    );
    return {
      counts: {
        workItems: page.items.length,
        overdueWorkItems: page.items.filter((w) => w.overdue).length,
        requests: requests.length,
        approvals: approvals.length,
      },
      hasMore: Boolean(page.nextCursor),
      actions,
    };
  },
});

// ---------------------------------------------------------------------------
// startWorkItem
// ---------------------------------------------------------------------------

async function loadOwnWorkItem(actor: CurrentUser, workItemId: string) {
  if (isBotActor(actor)) throw new OperationsToolError('Sólo una persona inicia su propio trabajo', 'forbidden');
  const item = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, title: true, status: true, ownerUserId: true, backupUserId: true },
  });
  if (!item) throw new OperationsToolError('No se encontró el trabajo', 'not_found');
  if (item.ownerUserId !== actor.id && item.backupUserId !== actor.id) {
    throw new OperationsToolError('Sólo el dueño del trabajo o su suplente puede iniciarlo', 'forbidden');
  }
  return item;
}

registerOperationsTool({
  name: 'startWorkItem',
  description:
    'Marca como iniciado uno de tus trabajos (eres el dueño o el suplente). Si el trabajo atiende una solicitud de otra área, iniciarlo la acepta.',
  requiredPermission: 'assistant.use',
  effect: 'internal_task',
  parameters: z.object({
    workItemId: idArg.describe('Id del trabajo'),
    workItemTitle: z.string().max(200).describe('Lo completa el sistema').optional(),
  }),
  summarize: (raw) => `Iniciar el trabajo «${truncateText((raw as { workItemTitle?: string; workItemId?: string }).workItemTitle ?? (raw as { workItemId?: string }).workItemId, 160)}»`,
  prepareArgs: async (actor, raw) => {
    const args = raw as { workItemId: string };
    const item = await loadOwnWorkItem(actor, args.workItemId);
    const { canTransitionWorkItem } = await import('@/modules/operations/work-items-service');
    if (!canTransitionWorkItem('start', item.status)) {
      return { error: item.status === 'in_progress' ? 'El trabajo ya está en curso' : `El trabajo está ${item.status}; no se puede iniciar` };
    }
    return { args: { workItemId: item.id, workItemTitle: truncateText(item.title, 200) } };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as { workItemId: string };
    const item = await loadOwnWorkItem(actor, args.workItemId);
    const { startWorkItem } = await import('@/modules/operations/work-items-service');
    await loadOperationsCommands();
    const result = unwrapCommand(await startWorkItem(actor, item.id, { commandId: transitionCommandId('startWorkItem', ctx) }));
    const dueAt = result.data?.dueAt ?? null;
    return {
      workItemId: item.id,
      title: item.title,
      status: result.data?.status ?? 'accepted',
      dueAt,
      dueLabel: dueAt ? formatDueLabel(dueAt) : null,
    };
  },
});

// ---------------------------------------------------------------------------
// recordCount
// ---------------------------------------------------------------------------

export interface ParsedCount {
  countedQty: number | null;
  unit: string | null;
  damagedQty: number | null;
  locationCode: string | null;
  skuHint: string | null;
  issues: string[];
}

const UNIT_ALTERNATIVES =
  'm²|m2|m\\^2|mts2|mt2|metros?\\s+cuadrados?|m³|m3|metros?\\s+c[uú]bicos?|pzas?|pzs|piezas?|pz|cajas?|rollos?|placas?|hojas?|kg|kilos?|kilogramos?|litros?|lts?|metros?|mts?|m|l|unidades?|juegos?|pares?|bultos?|sacos?|tramos?|paquetes?|tarimas?';
const QUANTITY_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)(?:\\s*(${UNIT_ALTERNATIVES}))?(?![\\p{L}\\d])`, 'giu');
const DAMAGE_WORD = '(?:dañad|danad|rot[oa]|quebrad|estrellad|defectuos|mal\\s+estado|merma|golpead|despostillad|rayad)';
const DAMAGE_AFTER = new RegExp(`^\\s*(?:[\\p{L}]+\\s+){0,2}${DAMAGE_WORD}`, 'iu');
const DAMAGE_BEFORE = new RegExp(`${DAMAGE_WORD}[\\p{L}]*\\s*(?:[:=]|son|hay)?\\s*$`, 'iu');
const LOCATION_KEYWORD = /(?:ubicaci[oó]n|rack|pasillo|anaquel|estante|nivel|zona|bin)\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{0,39})/iu;
const LOCATION_AFTER_EN = /\ben\s+([A-Z]{1,4}-?\d{1,4}[A-Z0-9-]*)(?![\w-])/u;
const SKU_KEYWORD = /\bsku\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{1,39})/iu;
const CODE_TOKEN = /(?<![\w-])([A-Z]{1,6}-?\d{1,6}[A-Z0-9-]*)(?![\w-])/gu;

function canonicalCountUnit(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (/cuadrad/.test(text)) return 'm2';
  if (/c[uú]bic/.test(text)) return 'm3';
  return normalizeUnit(raw) || null;
}

/**
 * Reads a count said in Spanish ("conté 10 m², 2 dañadas", "hay 24 piezas de
 * LP-01 en R-03"). Pure. Numbers inside codes (LP-01) and measures (60x60) are
 * not quantities. Several different counted quantities are reported as an
 * issue instead of guessing.
 */
export function parseCountText(text: string): ParsedCount {
  const source = String(text ?? '').slice(0, 500);
  const normalized = source.replace(/(\d),(\d)/g, '$1.$2');
  const issues: string[] = [];
  const counted: Array<{ value: number; unit: string | null }> = [];
  const damaged: Array<{ value: number; unit: string | null }> = [];

  for (const match of normalized.matchAll(QUANTITY_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const previous = normalized[start - 1] ?? '';
    if (/[\p{L}\d_\-/.]/u.test(previous)) continue; // part of a code (LP-01) or of a longer token
    if (/^\s*[x×*]\s*\d/i.test(normalized.slice(start + match[1].length))) continue; // measure 60x60
    if (/^[x×]\d/i.test(normalized.slice(end))) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const unit = canonicalCountUnit(match[2]);
    const after = normalized.slice(end, end + 40);
    const before = normalized.slice(Math.max(0, start - 30), start);
    if (DAMAGE_AFTER.test(after) || DAMAGE_BEFORE.test(before)) damaged.push({ value, unit });
    else counted.push({ value, unit });
  }

  const countedValues = [...new Set(counted.map((c) => c.value))];
  let countedQty: number | null = null;
  if (countedValues.length === 1) countedQty = countedValues[0];
  else if (countedValues.length > 1) {
    issues.push(`Encontré varias cantidades (${countedValues.join(', ')}): ¿cuál es el total que contaste?`);
  }
  const damagedValues = [...new Set(damaged.map((d) => d.value))];
  let damagedQty: number | null = null;
  if (damagedValues.length === 1) damagedQty = damagedValues[0];
  else if (damagedValues.length > 1) {
    issues.push(`Encontré varias cantidades dañadas (${damagedValues.join(', ')}): ¿cuántas están dañadas?`);
  }
  const units = [...new Set([...counted, ...damaged].map((c) => c.unit).filter((u): u is string => Boolean(u)))];
  if (units.length > 1) issues.push(`Encontré varias unidades (${units.join(', ')}): indica una sola unidad`);
  const unit = counted.find((c) => c.unit)?.unit ?? damaged.find((d) => d.unit)?.unit ?? null;

  const locationMatch = LOCATION_KEYWORD.exec(source) ?? LOCATION_AFTER_EN.exec(source);
  const locationCode = locationMatch ? locationMatch[1].toUpperCase() : null;

  let skuHint: string | null = SKU_KEYWORD.exec(source)?.[1] ?? null;
  if (!skuHint) {
    for (const codeMatch of source.matchAll(CODE_TOKEN)) {
      const code = codeMatch[1];
      if (locationCode && code.toUpperCase() === locationCode) continue;
      if (/^M[23]$/i.test(code)) continue;
      skuHint = code;
      break;
    }
  }

  return { countedQty, unit, damagedQty, locationCode, skuHint, issues };
}

const recordCountParams = z.object({
  text: z.string().trim().max(500).describe('Lo que dijo la persona, p. ej. "conté 10 m², 2 dañadas en R-03"').optional(),
  sku: z.string().trim().max(120).describe('SKU del artículo contado').optional(),
  product: z.string().trim().max(200).describe('Nombre del artículo, si no hay SKU').optional(),
  zohoItemId: idArg.describe('Artículo de Zoho (lo completa el sistema)').optional(),
  warehouse: z.string().trim().max(200).describe('Bodega (id, clave o nombre)').optional(),
  locationCode: z.string().trim().max(40).describe('Ubicación dentro de la bodega (GENERAL por omisión)').optional(),
  countedQty: z.number().min(0).describe('Cantidad total contada').optional(),
  damagedQty: z.number().min(0).describe('De lo contado, cuántas están dañadas').optional(),
  unit: z.string().trim().max(30).describe('Unidad del conteo; por omisión la unidad base').optional(),
  variantKey: z.string().max(400).describe('Variante, p. ej. "color=gris|medida=60x60"').optional(),
  countId: idArg.describe('Conteo abierto (lo completa el sistema)').optional(),
  warehouseId: idArg.describe('Lo completa el sistema').optional(),
  warehouseName: z.string().max(200).describe('Lo completa el sistema').optional(),
  productName: z.string().max(300).describe('Lo completa el sistema').optional(),
  baseUnit: z.string().max(30).describe('Lo completa el sistema').optional(),
});
type RecordCountArgs = z.output<typeof recordCountParams>;

interface CountProduct {
  zohoItemId: string;
  sku: string | null;
  name: string;
  unit: string | null;
}

const PRODUCT_SELECT = { zohoItemId: true, sku: true, name: true, unit: true } as const;

function productLabel(p: { sku: string | null; name: string | null; zohoItemId: string }): string {
  return `${p.name ?? p.zohoItemId}${p.sku ? ` (${p.sku})` : ''}`;
}

/** Product of the count: explicit id, SKU, name, or the only pending verification of the person. */
export async function resolveCountProduct(
  actor: CurrentUser,
  hints: { zohoItemId?: string; sku?: string | null; product?: string }
): Promise<CountProduct> {
  const toProduct = (row: { zohoItemId: string; sku: string | null; name: string | null; unit: string | null }): CountProduct => ({
    zohoItemId: row.zohoItemId,
    sku: row.sku,
    name: row.name ?? row.sku ?? row.zohoItemId,
    unit: row.unit,
  });
  if (hints.zohoItemId) {
    const row = await prisma.product.findUnique({ where: { zohoItemId: hints.zohoItemId }, select: PRODUCT_SELECT });
    if (!row) throw new OperationsToolError('No encontré el artículo indicado', 'not_found');
    return toProduct(row);
  }
  if (hints.sku) {
    const rows = await prisma.product.findMany({
      where: { sku: { equals: hints.sku, mode: 'insensitive' } },
      select: PRODUCT_SELECT,
      take: 3,
    });
    if (rows.length === 1) return toProduct(rows[0]);
    if (rows.length > 1) {
      throw new OperationsToolError(`Hay varios artículos con el SKU ${hints.sku}: ${rows.map(productLabel).join(', ')}`, 'ambiguous');
    }
    if (!hints.product) throw new OperationsToolError(`No encontré el SKU ${hints.sku}`, 'not_found');
  }
  if (hints.product) {
    const rows = await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: hints.product, mode: 'insensitive' } },
          { sku: { contains: hints.product, mode: 'insensitive' } },
        ],
      },
      select: PRODUCT_SELECT,
      take: 6,
    });
    if (rows.length === 1) return toProduct(rows[0]);
    if (rows.length === 0) throw new OperationsToolError(`No encontré «${truncateText(hints.product, 80)}» en el catálogo`, 'not_found');
    throw new OperationsToolError(
      `Varios artículos coinciden con «${truncateText(hints.product, 80)}»: ${rows.slice(0, 5).map(productLabel).join(', ')}. Indica el SKU`,
      'ambiguous'
    );
  }
  const items = await prisma.workItem.findMany({
    where: {
      kind: 'verification',
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      OR: [{ ownerUserId: actor.id }, { backupUserId: actor.id }],
    },
    select: { objectType: true, objectId: true, stepId: true },
    take: 10,
  });
  const demandIds = new Set(
    items.filter((i) => i.objectType === 'case_demand' && i.objectId).map((i) => i.objectId as string)
  );
  const stepIds = items.map((i) => i.stepId).filter((id): id is string => Boolean(id));
  if (stepIds.length > 0) {
    const steps = await prisma.caseStep.findMany({ where: { id: { in: stepIds } }, select: { demandId: true } });
    for (const step of steps) if (step.demandId) demandIds.add(step.demandId);
  }
  const demands = demandIds.size
    ? await prisma.caseDemand.findMany({
        where: { id: { in: [...demandIds] }, zohoItemId: { not: null } },
        select: { zohoItemId: true, sku: true, name: true },
      })
    : [];
  const unique = new Map(demands.map((d) => [d.zohoItemId as string, d]));
  if (unique.size === 1) {
    const [[zohoItemId, demand]] = [...unique.entries()];
    const row = await prisma.product.findUnique({ where: { zohoItemId }, select: PRODUCT_SELECT });
    return row ? toProduct(row) : { zohoItemId, sku: demand.sku, name: demand.name, unit: null };
  }
  if (unique.size > 1) {
    throw new OperationsToolError(
      `Tienes varias verificaciones abiertas (${[...unique.values()].slice(0, 5).map((d) => `${d.name}${d.sku ? ` (${d.sku})` : ''}`).join(', ')}): indica el SKU del artículo que contaste`,
      'ambiguous'
    );
  }
  throw new OperationsToolError('¿De qué artículo es el conteo? Indica el SKU o el nombre', 'ambiguous');
}

/** Warehouse of the count: explicit, the person's open count, the only active one, or the only one with stock. */
export async function resolveCountWarehouse(
  actor: CurrentUser,
  hints: { warehouse?: string; zohoItemId: string }
): Promise<{ id: string; key: string; name: string }> {
  const active = await prisma.warehouse.findMany({
    where: { active: true },
    select: { id: true, key: true, name: true },
    orderBy: { name: 'asc' },
    take: 50,
  });
  if (active.length === 0) throw new OperationsToolError('No hay bodegas activas', 'not_found');
  const options = () => active.slice(0, 8).map((w) => w.name).join(', ');
  if (hints.warehouse) {
    const needle = hints.warehouse.trim().toLowerCase();
    const exact = active.filter((w) => w.id === hints.warehouse || w.key.toLowerCase() === needle || w.name.toLowerCase() === needle);
    const matches = exact.length > 0 ? exact : active.filter((w) => w.name.toLowerCase().includes(needle));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new OperationsToolError(`No encontré la bodega «${truncateText(hints.warehouse, 60)}». Bodegas: ${options()}`, 'not_found');
    throw new OperationsToolError(`Varias bodegas coinciden con «${truncateText(hints.warehouse, 60)}»: ${matches.map((w) => w.name).join(', ')}`, 'ambiguous');
  }
  const counts = await prisma.stockCount.findMany({
    where: { startedBy: actor.id, status: { in: [...COUNT_OPEN_STATUSES] } },
    select: { warehouseId: true },
    take: 10,
  });
  const countWarehouses = active.filter((w) => counts.some((c) => c.warehouseId === w.id));
  if (countWarehouses.length === 1) return countWarehouses[0];
  if (active.length === 1) return active[0];
  const stock = await prisma.stockItem.findMany({
    where: { zohoItemId: hints.zohoItemId },
    select: { warehouseId: true },
    distinct: ['warehouseId'],
    take: 10,
  });
  const withStock = active.filter((w) => stock.some((s) => s.warehouseId === w.id));
  if (withStock.length === 1) return withStock[0];
  throw new OperationsToolError(`¿En qué bodega contaste? ${options()}`, 'ambiguous');
}

registerOperationsTool({
  name: 'recordCount',
  description:
    'Registra un conteo físico dicho en lenguaje natural ("conté 10 m², 2 dañadas en R-03"): identifica artículo, bodega, ubicación, cantidad y dañadas, rechaza lo ambiguo antes de la tarjeta y, al aprobarse, captura la línea en el conteo abierto (o abre uno) y bloquea las dañadas si hay permiso de ajuste.',
  requiredPermission: 'inventory.count',
  effect: 'business_write',
  parameters: recordCountParams,
  summarize: (raw) => {
    const a = raw as RecordCountArgs;
    const product = a.productName ? `${a.productName}${a.sku ? ` (${a.sku})` : ''}` : (a.sku ?? a.zohoItemId ?? 'artículo');
    const location = a.locationCode ? ` · ubicación ${a.locationCode}` : '';
    const damaged = a.damagedQty ? ` · ${a.damagedQty} ${a.unit ?? ''} dañadas` : '';
    return `Registrar conteo: ${a.countedQty ?? '?'} ${a.unit ?? ''} de ${product} en ${a.warehouseName ?? 'bodega'}${location}${damaged}`.replace(/\s+/g, ' ');
  },
  prepareArgs: async (actor, raw) => {
    const args = raw as RecordCountArgs;
    const scope = checkActingScope(actor, 'inventario');
    if (scope) return { error: scope };
    const parsed: ParsedCount = args.text
      ? parseCountText(args.text)
      : { countedQty: null, unit: null, damagedQty: null, locationCode: null, skuHint: null, issues: [] };
    if (args.countedQty === undefined && parsed.issues.length > 0) return { error: parsed.issues.join(' ') };
    const counted = args.countedQty ?? parsed.countedQty;
    if (counted === null || counted === undefined) {
      return { error: '¿Cuántas contaste en total? No encontré la cantidad contada' };
    }
    const damaged = args.damagedQty ?? parsed.damagedQty ?? 0;
    if (damaged > counted) return { error: 'Las dañadas no pueden ser más que lo contado' };

    const product = await resolveCountProduct(actor, {
      zohoItemId: args.zohoItemId,
      sku: args.sku ?? parsed.skuHint,
      product: args.product,
    });
    const { DEFAULT_BASE_UNIT, toUnitProfile } = await import('@/modules/inventory/profiles-service');
    const profile = await prisma.productInventoryProfile.findUnique({
      where: { zohoItemId: product.zohoItemId },
      select: { baseUnit: true, conversions: true, variantAxes: true },
    });
    const units: UnitProfile = profile
      ? toUnitProfile(profile)
      : { baseUnit: normalizeUnit(product.unit) || DEFAULT_BASE_UNIT, conversions: [] };
    const unit = normalizeUnit(args.unit ?? parsed.unit ?? '') || units.baseUnit;
    try {
      toBase(counted, unit, units);
    } catch (err) {
      if (err instanceof StockMathError) {
        const known = [units.baseUnit, ...units.conversions.map((c) => c.unit)].join(', ');
        return { error: `${err.message}. Unidades válidas para ${product.name}: ${known}` };
      }
      throw err;
    }
    if (profile && profile.variantAxes.length > 0 && !args.variantKey) {
      return { error: `${product.name} se controla por ${profile.variantAxes.join(', ')}: indica la variante (variantKey, p. ej. "${profile.variantAxes[0]}=…")` };
    }
    const warehouse = await resolveCountWarehouse(actor, { warehouse: args.warehouse, zohoItemId: product.zohoItemId });
    let locationCode = args.locationCode ?? parsed.locationCode ?? null;
    if (locationCode) {
      const { normalizeLocationCode } = await import('@/modules/inventory/warehouses-service');
      const code = normalizeLocationCode(locationCode);
      if (code !== 'GENERAL' && code !== 'SCRAP') {
        const location = await prisma.storageLocation.findUnique({
          where: { warehouseId_code: { warehouseId: warehouse.id, code } },
          select: { active: true },
        });
        if (!location?.active) {
          const known = await prisma.storageLocation.findMany({
            where: { warehouseId: warehouse.id, active: true },
            select: { code: true },
            orderBy: { code: 'asc' },
            take: 12,
          });
          return { error: `No existe la ubicación ${code} en ${warehouse.name}. Ubicaciones: ${known.map((l) => l.code).join(', ') || 'GENERAL'}` };
        }
      }
      locationCode = code;
    }
    const openCount = await prisma.stockCount.findFirst({
      where: { warehouseId: warehouse.id, startedBy: actor.id, status: { in: [...COUNT_OPEN_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return {
      args: {
        ...(args.text ? { text: args.text } : {}),
        zohoItemId: product.zohoItemId,
        ...(product.sku ? { sku: product.sku } : {}),
        productName: truncateText(product.name, 300),
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        ...(locationCode ? { locationCode } : {}),
        countedQty: counted,
        damagedQty: damaged,
        unit,
        baseUnit: units.baseUnit,
        ...(args.variantKey ? { variantKey: args.variantKey } : {}),
        ...(openCount ? { countId: openCount.id } : {}),
      },
    };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as RecordCountArgs;
    assertActingScope(actor, 'inventario', ctx);
    if (isBotActor(actor)) throw new OperationsToolError('Un conteo lo registra la persona que contó', 'forbidden');
    if (!args.zohoItemId || !args.warehouseId || args.countedQty === undefined) {
      throw new OperationsToolError('Faltan el artículo, la bodega o la cantidad contada', 'invalid_args');
    }
    const inventory = await import('@/modules/inventory/inventory-commands');
    await loadOperationsCommands();

    let countId = args.countId;
    if (countId) {
      const count = await prisma.stockCount.findUnique({ where: { id: countId }, select: { status: true, warehouseId: true } });
      if (!count || count.warehouseId !== args.warehouseId || !(COUNT_OPEN_STATUSES as readonly string[]).includes(count.status)) {
        countId = undefined;
      }
    }
    let countStarted = false;
    if (!countId) {
      const started = unwrapCommand(
        await inventory.startStockCount(
          actor,
          { warehouseId: args.warehouseId, scope: 'spot' },
          { commandId: transitionCommandId('recordCount', ctx, 'start') }
        )
      );
      countId = started.data?.count.id;
      if (!countId) throw new OperationsToolError('No se pudo abrir el conteo; intenta de nuevo', 'accepted');
      countStarted = true;
    }
    const line = unwrapCommand(
      await inventory.recordStockCountLine(
        actor,
        {
          countId,
          zohoItemId: args.zohoItemId,
          locationCode: args.locationCode ?? null,
          variantKey: args.variantKey ?? null,
          countedQty: String(args.countedQty),
          unit: args.unit ?? null,
        },
        { commandId: transitionCommandId('recordCount', ctx, 'line') }
      )
    ).data;

    let damaged: Record<string, unknown> | null = null;
    if (args.damagedQty && args.damagedQty > 0 && line) {
      if (actorHas(actor, 'inventory.adjust')) {
        try {
          const blocked = unwrapCommand(
            await inventory.blockStockQuantity(
              actor,
              {
                stockItemId: line.stockItemId,
                quantity: String(args.damagedQty),
                unit: args.unit ?? null,
                reason: truncateText(`Dañadas en conteo${args.text ? `: ${args.text}` : ''}`, 500),
              },
              { commandId: transitionCommandId('recordCount', ctx, 'block') }
            )
          );
          damaged = { quantity: args.damagedQty, unit: args.unit ?? line.baseUnit, blocked: true, blockedTotal: blocked.data?.blocked ?? null };
        } catch (err) {
          damaged = {
            quantity: args.damagedQty,
            unit: args.unit ?? line.baseUnit,
            blocked: false,
            note: `El conteo quedó registrado, pero no se pudieron bloquear las dañadas: ${err instanceof Error ? err.message : 'error'}`,
          };
        }
      } else {
        damaged = {
          quantity: args.damagedQty,
          unit: args.unit ?? line.baseUnit,
          blocked: false,
          note: 'No tienes permiso de ajuste: avisa a Inventario para bloquear las dañadas',
        };
      }
    }
    return {
      countId,
      countStarted,
      productName: args.productName ?? null,
      warehouseName: args.warehouseName ?? null,
      stockItemId: line?.stockItemId ?? null,
      expected: line?.expected ?? null,
      counted: line?.counted ?? null,
      diff: line?.diff ?? null,
      withinTolerance: line?.withinTolerance ?? null,
      baseUnit: line?.baseUnit ?? args.baseUnit ?? null,
      confidence: line?.confidence ?? null,
      recount: line?.recount ?? false,
      damaged,
      nextStep: 'Cierra el conteo desde Inventario cuando termines de contar esa bodega',
    };
  },
});

import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { listPendingProposals } from '@/modules/extensions/proposals-service';
import { listPendingApprovals } from '@/modules/operations/approvals-service';
import { AREA_REQUEST_KIND_CATALOG, isAreaRequestKind } from '@/modules/operations/request-kinds';
import {
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  AREA_REQUEST_STATUS_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  WORK_ITEM_STATUS_LABELS,
} from '@/modules/operations/types';
import { PROMPT_MAX_CHARS, caseRefs, due, joinParts, overdueLabel, renderSections, safe, text } from './shared';

/**
 * Surface prompt of "Mi trabajo" (plan 5.2): the person's open work items
 * (owner or backup), requests they answer, business approvals they can decide
 * and AI proposals waiting for them. Only the actor's own data is loaded.
 */

export const MYWORK_PROMPT_LIMITS = {
  workItems: 15,
  requests: 10,
  approvals: 8,
  proposals: 5,
} as const;

const label = (map: Record<string, string>, value: string): string => map[value] ?? value;

export async function buildMyWorkPrompt(actor: CurrentUser): Promise<string> {
  const now = new Date();
  const mine = [{ ownerUserId: actor.id }, { backupUserId: actor.id }];
  const openWork = { in: [...WORK_ITEM_OPEN_STATUSES] };

  const [workItems, workTotal, overdueTotal, requests, requestsTotal, approvals, proposals] = await Promise.all([
    safe(
      'mywork.workItems',
      () =>
        prisma.workItem.findMany({
          where: { OR: mine, status: openWork },
          orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
          take: MYWORK_PROMPT_LIMITS.workItems,
        }),
      []
    ),
    safe('mywork.workTotal', () => prisma.workItem.count({ where: { OR: mine, status: openWork } }), 0),
    safe(
      'mywork.overdueTotal',
      () => prisma.workItem.count({ where: { OR: mine, status: openWork, dueAt: { lt: now } } }),
      0
    ),
    safe(
      'mywork.requests',
      () =>
        prisma.areaRequest.findMany({
          where: { OR: mine, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } },
          orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
          take: MYWORK_PROMPT_LIMITS.requests,
        }),
      []
    ),
    safe(
      'mywork.requestsTotal',
      () => prisma.areaRequest.count({ where: { OR: mine, status: { in: [...AREA_REQUEST_OPEN_STATUSES] } } }),
      0
    ),
    safe('mywork.approvals', () => listPendingApprovals(actor, { limit: MYWORK_PROMPT_LIMITS.approvals, now }), []),
    safe('mywork.proposals', () => listPendingProposals(actor), []),
  ]);

  const refs = await safe(
    'mywork.refs',
    () => caseRefs([...workItems.map((w) => w.caseId), ...requests.map((r) => r.caseId), ...approvals.map((a) => a.caseId)]),
    new Map<string, string>()
  );

  return renderSections(
    [
      {
        title: 'Mi trabajo',
        rules: [
          'Ayudas a esta persona a decidir qué hacer primero: lo vencido y lo que bloquea entregas va antes.',
          'Propón el siguiente paso concreto citando ids entre corchetes (son argumentos de tus tools). Las acciones con efecto se proponen para su aprobación.',
          'Si pide registrar un conteo, usa la tool de conteo con cantidad, unidad y ubicación; si algo es ambiguo, pregunta antes.',
        ],
      },
      {
        title: 'Persona',
        data: [joinParts([`Usuario: ${text(actor.name, 80)}`, `@${actor.username}`])],
        source: 'persona',
        priority: 9,
      },
      {
        title: `Trabajos (${workTotal} abiertos, ${overdueTotal} vencidos)`,
        data: workItems.map((w) =>
          joinParts([
            `[${w.id}] "${text(w.title, 120)}"`,
            label(AREA_LABELS, w.areaKey),
            label(WORK_ITEM_STATUS_LABELS, w.status),
            overdueLabel(w.dueAt, now, 'VENCIDO') || `vence ${due(w.dueAt, now)}`,
            w.ownerUserId === actor.id ? 'titular' : 'suplente',
            w.caseId ? (refs.get(w.caseId) ?? null) : null,
          ])
        ),
        total: workTotal,
        source: 'mis_trabajos',
        priority: 6,
        empty: 'No tiene trabajos abiertos.',
      },
      {
        title: `Solicitudes a su cargo (${requestsTotal})`,
        data: requests.map((r) =>
          joinParts([
            `[${r.id}] ${isAreaRequestKind(r.kind) ? AREA_REQUEST_KIND_CATALOG[r.kind].label : r.kind} de ${label(AREA_LABELS, r.fromAreaKey)}`,
            label(AREA_REQUEST_STATUS_LABELS, r.status),
            overdueLabel(r.dueAt, now, 'VENCIDA') || `vence ${due(r.dueAt, now)}`,
            r.blocksDelivery ? 'bloquea entrega' : null,
            refs.get(r.caseId) ?? null,
            `"${text(r.title, 120)}"`,
          ])
        ),
        total: requestsTotal,
        source: 'mis_solicitudes',
        priority: 5,
        empty: 'Sin solicitudes a su cargo.',
      },
      {
        title: `Aprobaciones de negocio que puede decidir (${approvals.length})`,
        data: approvals.map((a) =>
          joinParts([
            `[${a.id}] ${a.scopeLabel}`,
            `${Number(a.amount).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${a.currency}`,
            `${a.approvals} de ${a.requiredApprovals} firmas`,
            a.caseId ? (refs.get(a.caseId) ?? null) : null,
            a.expiresAt ? `vence ${due(a.expiresAt, now)}` : null,
          ])
        ),
        source: 'mis_aprobaciones',
        priority: 4,
        empty: 'Sin aprobaciones pendientes.',
      },
      {
        title: `Propuestas de IA por decidir (${proposals.length})`,
        data: proposals.slice(0, MYWORK_PROMPT_LIMITS.proposals).map((p) =>
          joinParts([
            `[${p.id}] ${p.toolName}`,
            `"${text(p.summary, 140)}"`,
            p.status === 'awaiting_second_approval' ? 'falta segunda firma' : null,
            `vence ${due(p.expiresAt, now)}`,
          ])
        ),
        total: proposals.length,
        source: 'mis_propuestas',
        priority: 3,
        empty: 'Sin propuestas pendientes.',
      },
    ],
    PROMPT_MAX_CHARS
  );
}

import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { getCaseSnapshot, type CaseSnapshot } from '@/modules/operations/case-service';
import { isOperationsError } from '@/modules/operations/errors';
import { AREA_REQUEST_KIND_CATALOG, isAreaRequestKind } from '@/modules/operations/request-kinds';
import {
  AREA_LABELS,
  AREA_REQUEST_STATUS_LABELS,
  INCIDENT_SEVERITY_LABELS,
  PRIORITY_LABELS,
  WORK_ITEM_STATUS_LABELS,
} from '@/modules/operations/types';
import { formatQuantity, formatShortDate, formatTimelineLine } from '../templates';
import { PROMPT_MAX_CHARS, due, joinParts, overdueLabel, renderSections, safe, text, userNames } from './shared';

/**
 * Surface prompt of a case room (plan 5.2): the case snapshot from the core
 * (`getCaseSnapshot`, which enforces case access for the actor), the previous AI
 * summary, open work items, requests, open incidents, demands, deliveries and
 * the last 10 timeline lines rendered with the same `formatTimelineLine` as the
 * chat room. Every dynamic value goes inside untrusted blocks.
 */

export const CASE_PROMPT_LIMITS = {
  workItems: 8,
  requests: 8,
  incidents: 6,
  demands: 10,
  deliveries: 3,
  timeline: 10,
  summaryChars: 900,
} as const;

const label = (map: Record<string, string>, value: string): string => map[value] ?? value;

function accessDenied(): string {
  return renderSections([
    {
      title: 'Sala del expediente',
      rules: [
        'La persona no tiene acceso a este expediente. No reveles su contenido; sugiere pedir acceso al responsable del expediente o a Administración.',
      ],
    },
  ]);
}

function unavailable(reason: string): string {
  return renderSections([
    {
      title: 'Sala del expediente',
      rules: [`${reason} Consulta el expediente con tus tools antes de responder y no supongas su estado.`],
    },
  ]);
}

async function loadSnapshot(actor: CurrentUser, caseId: string): Promise<CaseSnapshot | 'forbidden' | 'failed' | null> {
  try {
    // An AI identity reaches a case only through the dispatcher and its tool scope (involved area,
    // mention lock), so it reads the snapshot without the human room-membership rule.
    return await getCaseSnapshot(caseId, actor.isBot === true ? {} : { actor });
  } catch (err) {
    if (isOperationsError(err) && err.code === 'forbidden') return 'forbidden';
    console.warn(
      JSON.stringify({
        component: 'agents-prompts',
        event: 'case_snapshot_failed',
        caseId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return 'failed';
  }
}

export async function buildCaseRoomPrompt(actor: CurrentUser, caseId: string): Promise<string> {
  const snapshot = await loadSnapshot(actor, caseId);
  if (snapshot === 'forbidden') return accessDenied();
  if (snapshot === 'failed') return unavailable('No se pudo cargar el expediente.');
  if (!snapshot) return unavailable('El expediente no existe.');

  const now = new Date();
  const c = snapshot.case;
  const [extra, names] = await Promise.all([
    safe(
      'case.summary',
      () => prisma.operationalCase.findUnique({ where: { id: c.id }, select: { aiSummary: true } }),
      null
    ),
    safe(
      'case.names',
      () =>
        userNames([
          c.ownerUserId,
          ...snapshot.openWorkItems.flatMap((w) => [w.ownerUserId, w.backupUserId]),
        ]),
      new Map<string, string>()
    ),
  ]);

  const workItems = [...snapshot.openWorkItems].sort((a, b) => Number(b.overdue) - Number(a.overdue));

  return renderSections(
    [
      {
        title: `Sala del expediente ${text(c.caseNumber, 40)}`,
        rules: [
          'Coordinas este expediente entre áreas: di qué falta para entregar, quién lo tiene y qué lo bloquea.',
          'No prometas fechas ni cantidades al cliente sin verificarlas con tools. Los ids entre corchetes son argumentos de tus tools.',
          'Si algo bloquea la entrega, identifica el área y su responsable y crea o escala la solicitud; las acciones con efecto se proponen para aprobación humana.',
        ],
      },
      {
        title: 'Encabezado',
        data: [
          joinParts([
            `[${c.id}] ${c.caseNumber}`,
            c.salesOrderNumber ? `OV ${c.salesOrderNumber}` : null,
            c.customerName ? `cliente ${c.customerName}` : null,
          ]),
          joinParts([
            `estado ${c.statusLabel}`,
            `fase ${c.phaseLabel}`,
            `prioridad ${label(PRIORITY_LABELS, c.priority).toLowerCase()}`,
            c.deliveryMethod ? `entrega ${c.deliveryMethod}` : null,
            c.locationName ? `ubicación ${c.locationName}` : null,
          ]),
          joinParts([
            c.promisedAt ? `promesa ${formatShortDate(c.promisedAt)}` : 'sin promesa de entrega',
            names.get(c.ownerUserId) ? `responsable ${names.get(c.ownerUserId)}` : null,
            `última actividad ${due(c.lastActivityAt, now)}`,
            `proceso ${c.process}`,
          ]),
        ],
        source: 'expediente',
        priority: 9,
      },
      ...(extra?.aiSummary
        ? [
            {
              title: 'Resumen previo (generado por IA a partir de los eventos)',
              data: [extra.aiSummary],
              source: 'resumen_ia',
              priority: 7,
              lineMax: CASE_PROMPT_LIMITS.summaryChars,
            },
          ]
        : []),
      {
        title: `Trabajos abiertos (${snapshot.openWorkItems.length})`,
        data: workItems.slice(0, CASE_PROMPT_LIMITS.workItems).map((w) =>
          joinParts([
            `[${w.id}] "${text(w.title, 120)}"`,
            label(AREA_LABELS, w.areaKey),
            label(WORK_ITEM_STATUS_LABELS, w.status),
            w.overdue ? overdueLabel(w.dueAt, now, 'VENCIDO') : `vence ${due(w.dueAt, now)}`,
            names.get(w.ownerUserId) ? `resp. ${names.get(w.ownerUserId)}` : null,
            w.backupUserId && names.get(w.backupUserId) ? `suplente ${names.get(w.backupUserId)}` : null,
          ])
        ),
        total: snapshot.openWorkItems.length,
        source: 'trabajos_expediente',
        priority: 6,
        empty: 'No hay trabajos abiertos.',
      },
      {
        title: 'Solicitudes entre áreas',
        data: snapshot.requests.slice(0, CASE_PROMPT_LIMITS.requests).map((r) =>
          joinParts([
            `[${r.id}] ${isAreaRequestKind(r.kind) ? AREA_REQUEST_KIND_CATALOG[r.kind].label : r.kind}`,
            `${label(AREA_LABELS, r.fromAreaKey)} → ${label(AREA_LABELS, r.toAreaKey)}`,
            label(AREA_REQUEST_STATUS_LABELS, r.status),
            `vence ${due(r.dueAt, now)}`,
            r.blocksDelivery ? 'bloquea entrega' : null,
            `"${text(r.title, 120)}"`,
          ])
        ),
        total: snapshot.requests.length,
        source: 'solicitudes_expediente',
        priority: 6,
        empty: 'Sin solicitudes.',
      },
      {
        title: `Incidencias abiertas (${snapshot.incidents.length})`,
        data: snapshot.incidents.slice(0, CASE_PROMPT_LIMITS.incidents).map((i) =>
          joinParts([
            `[${i.id}] ${label(INCIDENT_SEVERITY_LABELS, i.severity).toLowerCase()}`,
            `"${text(i.title, 120)}"`,
            `abierta ${due(i.openedAt, now)}`,
          ])
        ),
        total: snapshot.incidents.length,
        source: 'incidencias_expediente',
        priority: 5,
        empty: 'Sin incidencias abiertas.',
      },
      {
        title: `Partidas (${snapshot.demands.length})`,
        data: snapshot.demands.slice(0, CASE_PROMPT_LIMITS.demands).map((d) => {
          const allocations = snapshot.allocations.filter((a) => a.demandId === d.id);
          return joinParts([
            `[${d.id}] ${d.sku ? `${d.sku} ` : ''}${text(d.name, 80)}`,
            formatQuantity(d.quantity, d.unit),
            d.status,
            Number(d.fulfilledQuantity) > 0 ? `entregado ${formatQuantity(d.fulfilledQuantity, d.unit)}` : null,
            allocations.length > 0
              ? `origen ${allocations.map((a) => `${a.source}:${a.status}`).join(', ')}`
              : null,
          ]);
        }),
        total: snapshot.demands.length,
        source: 'partidas',
        priority: 3,
        empty: 'Sin partidas.',
      },
      {
        title: 'Entregas',
        data: snapshot.delivery.orders.slice(0, CASE_PROMPT_LIMITS.deliveries).map((o) =>
          joinParts([
            `[${o.id}] ${o.status}`,
            o.mode,
            `Zoho ${o.zohoSyncState}`,
            o.plannedDate ? `planeada ${formatShortDate(o.plannedDate)}` : null,
            o.carrier ? `transportista ${o.carrier}` : null,
            o.deliveredAt ? `entregada ${due(o.deliveredAt, now)}` : null,
          ])
        ),
        total: snapshot.delivery.orders.length,
        source: 'entregas',
        priority: 2,
        empty: 'Sin órdenes de entrega todavía.',
      },
      {
        title: 'Cronología (últimos eventos, hora de México)',
        data: snapshot.timeline
          .slice(0, CASE_PROMPT_LIMITS.timeline)
          .reverse()
          .map((event) =>
            formatTimelineLine({
              id: event.id,
              type: event.type,
              occurredAt: event.occurredAt,
              areaKey: event.areaKey,
              actorType: event.actorType,
              payload: event.summary,
            })
          ),
        source: 'cronologia',
        priority: 1,
        empty: 'Sin eventos.',
      },
    ].map((section) => ({ ...section, data: section.data?.filter(Boolean) })),
    PROMPT_MAX_CHARS
  ).replace(/\n{3,}/g, '\n\n');
}

import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  AREA_KEYS,
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  CASE_OPEN_STATUSES,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_LABELS,
  WORK_ITEM_OPEN_STATUSES,
} from '@/modules/operations/types';
import { getAreaAiUsage } from '../budget';
import { ADMIN_AGENT_DEFINITION } from '../identity-catalog';
import { PROMPT_MAX_CHARS, joinParts, renderSections, safe, text } from './shared';
import { formatDuration } from '../templates';

/**
 * Surface prompt of the Control Tower (plan 5.2): company pulse (open cases,
 * overdue work by area, open incidents by severity, blocked/overdue requests),
 * stuck cases (24 h without events) and today's AI consumption by area.
 * Requires `operations.admin` (or super admin, or the administrator bot).
 */

export const CONTROL_TOWER_PROMPT_LIMITS = {
  stuckCases: 8,
  stuckAfterHours: 24,
} as const;

const label = (map: Record<string, string>, value: string): string => map[value] ?? value;

function canUseControlTower(actor: CurrentUser): boolean {
  return (
    actor.isSuperAdmin ||
    hasPermission(actor, 'operations.admin') ||
    actor.roleKeys.includes(ADMIN_AGENT_DEFINITION.roleKey)
  );
}

type CountRow = { _count: { _all: number } } & Record<string, unknown>;

function countsText(rows: CountRow[], key: string, labels: Record<string, string>, order: readonly string[]): string {
  const byKey = new Map(rows.map((row) => [String(row[key]), row._count._all]));
  return order
    .filter((value) => (byKey.get(value) ?? 0) > 0)
    .map((value) => `${label(labels, value).toLowerCase()} ${byKey.get(value)}`)
    .join(' · ');
}

const total = (rows: Array<{ _count: { _all: number } }>) => rows.reduce((sum, row) => sum + row._count._all, 0);

export async function buildControlTowerPrompt(actor: CurrentUser): Promise<string> {
  if (!canUseControlTower(actor)) {
    return renderSections([
      {
        title: 'Control Tower',
        rules: [
          'La persona no tiene el permiso de administración de operaciones. No reveles cifras de la empresa; sugiere pedir acceso a Administración.',
        ],
      },
    ]);
  }

  const now = new Date();
  const stuckBefore = new Date(now.getTime() - CONTROL_TOWER_PROMPT_LIMITS.stuckAfterHours * 3_600_000);
  const openCase = { in: [...CASE_OPEN_STATUSES] };

  const [casesByStatus, overdueByArea, incidentsBySeverity, blockedRequests, overdueRequests, stuckCases, stuckTotal, usage, pausedAgents] =
    await Promise.all([
      safe(
        'ct.casesByStatus',
        () =>
          prisma.operationalCase.groupBy({ by: ['status'], where: { status: openCase }, _count: { _all: true } }),
        []
      ),
      safe(
        'ct.overdueByArea',
        () =>
          prisma.workItem.groupBy({
            by: ['areaKey'],
            where: { status: { in: [...WORK_ITEM_OPEN_STATUSES] }, dueAt: { lt: now } },
            _count: { _all: true },
          }),
        []
      ),
      safe(
        'ct.incidentsBySeverity',
        () =>
          prisma.incident.groupBy({
            by: ['severity'],
            where: { status: { in: [...INCIDENT_OPEN_STATUSES] } },
            _count: { _all: true },
          }),
        []
      ),
      safe('ct.blockedRequests', () => prisma.areaRequest.count({ where: { status: 'blocked' } }), 0),
      safe(
        'ct.overdueRequests',
        () =>
          prisma.areaRequest.count({ where: { status: { in: [...AREA_REQUEST_OPEN_STATUSES] }, dueAt: { lt: now } } }),
        0
      ),
      safe(
        'ct.stuckCases',
        () =>
          prisma.operationalCase.findMany({
            where: { status: openCase, lastActivityAt: { lt: stuckBefore } },
            orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
            take: CONTROL_TOWER_PROMPT_LIMITS.stuckCases,
            select: {
              id: true,
              caseNumber: true,
              salesOrderNumber: true,
              customerName: true,
              status: true,
              phase: true,
              lastActivityAt: true,
            },
          }),
        []
      ),
      safe(
        'ct.stuckTotal',
        () => prisma.operationalCase.count({ where: { status: openCase, lastActivityAt: { lt: stuckBefore } } }),
        0
      ),
      safe('ct.usage', () => getAreaAiUsage({ from: now, to: now }), null),
      safe(
        'ct.pausedAgents',
        () =>
          prisma.agentIdentity.findMany({
            where: { mode: { not: 'active' } },
            select: { key: true, displayName: true, mode: true },
            orderBy: { key: 'asc' },
          }),
        []
      ),
    ]);

  const pulse = [
    joinParts([
      `Expedientes abiertos: ${total(casesByStatus)}`,
      countsText(casesByStatus, 'status', CASE_STATUS_LABELS, CASE_OPEN_STATUSES),
    ]),
    joinParts([
      `Trabajos vencidos: ${total(overdueByArea)}`,
      countsText(overdueByArea, 'areaKey', AREA_LABELS, AREA_KEYS),
    ]),
    joinParts([
      `Incidencias abiertas: ${total(incidentsBySeverity)}`,
      countsText(incidentsBySeverity, 'severity', INCIDENT_SEVERITY_LABELS, [...INCIDENT_SEVERITIES].reverse()),
    ]),
    `Solicitudes bloqueadas: ${blockedRequests} · vencidas: ${overdueRequests}`,
    `Expedientes sin avance en ${CONTROL_TOWER_PROMPT_LIMITS.stuckAfterHours} h: ${stuckTotal}`,
  ];

  const usageLines = usage
    ? [
        ...usage.areas
          .filter((area) => area.tokens > 0 || area.turns > 0)
          .map((area) =>
            joinParts([
              `${area.label}: ${area.tokens.toLocaleString('es-MX')} tokens`,
              `${area.turns} turnos`,
              `US$${area.usd.toFixed(2)}`,
            ])
          ),
        `Total del día: ${usage.totals.tokens.toLocaleString('es-MX')} tokens · US$${usage.totals.usd.toFixed(2)} · ${usage.totals.skipped} turnos saltados`,
      ]
    : [];
  if (pausedAgents.length > 0) {
    usageLines.push(`IA fuera de modo activo: ${pausedAgents.map((a) => `${text(a.displayName, 40)} (${a.mode})`).join(', ')}`);
  }

  return renderSections(
    [
      {
        title: 'Control Tower',
        rules: [
          'Das a Administración la foto de la operación: expedientes, vencidos, incidencias, bloqueos y consumo de IA por área.',
          'Señala el cuello de botella con cifras obtenidas de tools y di a quién escalar; no inventes números.',
          'Los ids entre corchetes son argumentos de tus tools. Las acciones con efecto se proponen para aprobación humana.',
        ],
      },
      { title: 'Pulso de la empresa', data: pulse, source: 'pulso_empresa', priority: 9 },
      {
        title: `Expedientes atorados (${stuckTotal})`,
        data: stuckCases.map((c) =>
          joinParts([
            `[${c.id}] ${c.caseNumber}`,
            c.salesOrderNumber ? `OV ${c.salesOrderNumber}` : null,
            `${label(CASE_STATUS_LABELS, c.status).toLowerCase()} · fase ${label(CASE_PHASE_LABELS, c.phase).toLowerCase()}`,
            `${formatDuration((now.getTime() - c.lastActivityAt.getTime()) / 60_000)} sin avance`,
            c.customerName ? `cliente ${text(c.customerName, 80)}` : null,
          ])
        ),
        total: stuckTotal,
        source: 'expedientes_atorados',
        priority: 6,
        empty: 'Ningún expediente atorado.',
      },
      {
        title: 'Consumo de IA de hoy',
        data: usageLines,
        source: 'consumo_ia',
        priority: 3,
        empty: 'Sin consumo registrado hoy.',
      },
    ],
    PROMPT_MAX_CHARS
  );
}

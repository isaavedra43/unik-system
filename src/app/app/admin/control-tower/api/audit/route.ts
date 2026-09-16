import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AUDIT_TARGET_TYPES } from '@/components/control-tower/audit-model';
import {
  controlTowerErrorResponse,
  dateParam,
  intParam,
  listParam,
  resolveControlTowerRoute,
} from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auditoría filtrada a operaciones (plan 7.7 `auditoria`).
 *
 * `AuditLog` guarda todo el sistema; aquí se muestran sólo los objetos de la
 * operación: el núcleo (expedientes, trabajo, solicitudes, incidencias,
 * comandos, aprobaciones, agentes), los agregados de dominio sobre los que la
 * gente manda comandos (órdenes de compra, conteos, viajes, gastos…) y la
 * administración de la propia operación. El filtro por texto se aplica a la
 * ACCIÓN, no al JSON de metadatos, para no barrer la tabla entera.
 *
 * EL VOCABULARIO VIVE EN UN SOLO LUGAR (`components/control-tower/audit-model`,
 * que es puro y lo comparte la pantalla). Tener aquí una copia propia hacía que
 * el selector ofreciera tipos que esta ruta descartaba: al quedarse sin tipos
 * válidos caía al `else` y devolvía TODO menos lo pedido.
 */
const OPERATIONS_TARGET_TYPES = AUDIT_TARGET_TYPES;

const PAGE_SIZE_BOUNDS = { min: 5, max: 200 };

export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  const pageSize = intParam(params, 'page_size', PAGE_SIZE_BOUNDS) ?? 50;
  const page = intParam(params, 'page', { min: 1, max: 1000 }) ?? 1;
  const requestedTypes = listParam(params, 'targetType', OPERATIONS_TARGET_TYPES.length);
  const targetTypes = requestedTypes.filter(
    (value): value is (typeof OPERATIONS_TARGET_TYPES)[number] =>
      (OPERATIONS_TARGET_TYPES as readonly string[]).includes(value)
  );
  // Se pidió filtrar por un tipo que no es de operaciones: la respuesta es
  // «nada», nunca «todo». Caer a la lista completa devolvía lo contrario de lo
  // que se pidió y parecía que el filtro no funcionaba.
  const unknownTypeRequested = requestedTypes.length > 0 && targetTypes.length === 0;
  const action = params.get('action')?.trim() ?? '';
  const actorUserId = params.get('actorUserId')?.trim() ?? '';
  const targetId = params.get('targetId')?.trim() ?? '';
  const from = dateParam(params, 'from');
  const to = dateParam(params, 'to');

  const where: Prisma.AuditLogWhereInput = {
    targetType: {
      in: unknownTypeRequested
        ? []
        : targetTypes.length > 0
          ? targetTypes
          : [...OPERATIONS_TARGET_TYPES],
    },
    ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
      : {}),
  };

  try {
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          actorUserId: true,
          action: true,
          targetType: true,
          targetId: true,
          metadata: true,
          createdAt: true,
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, username: true, isBot: true },
        })
      : [];
    const byId = new Map(actors.map((row) => [row.id, row]));

    return NextResponse.json({
      data: rows.map((row) => {
        const actor = row.actorUserId ? byId.get(row.actorUserId) : null;
        return {
          id: row.id,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          metadata: row.metadata,
          createdAt: row.createdAt.toISOString(),
          actorUserId: row.actorUserId,
          actorName: actor ? actor.name || actor.username : null,
          actorIsBot: actor?.isBot ?? false,
        };
      }),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
      },
      targetTypes: [...OPERATIONS_TARGET_TYPES],
    });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

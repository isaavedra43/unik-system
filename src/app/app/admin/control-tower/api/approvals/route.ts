import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { listPendingApprovals } from '@/modules/operations/approvals-service';
import { listPendingProposals } from '@/modules/extensions/proposals-service';
import { AREA_LABELS, isAreaKey } from '@/modules/operations/types';
import { controlTowerErrorResponse, intParam, resolveControlTowerRoute } from '../_ct-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WORK_ITEMS = 200;

/**
 * Lo que espera una firma (plan 7.7 `aprobaciones`): propuestas de IA
 * pendientes de todas las superficies, aprobaciones de negocio que esta persona
 * puede decidir y los work items de tipo `approval` que siguen abiertos.
 *
 * Nada se decide aquí: esta ruta sólo LEE. Las decisiones siguen pasando por
 * `POST /app/operations/api/proposals/[id]` y por los comandos del núcleo, que
 * son los que aplican las reglas de doble firma y de auto-aprobación.
 */
export async function GET(request: Request) {
  const context = await resolveControlTowerRoute();
  if (!context.ok) return context.response;
  const params = new URL(request.url).searchParams;
  const limit = intParam(params, 'limit', { min: 1, max: 200 }) ?? 50;
  const now = new Date();
  try {
    const [approvals, proposals, workItems] = await Promise.all([
      listPendingApprovals(context.user, { limit, now }),
      listPendingProposals(context.user),
      prisma.workItem.findMany({
        where: {
          kind: 'approval',
          status: { in: ['open', 'in_progress', 'waiting', 'escalated'] },
        },
        orderBy: [{ dueAt: 'asc' }],
        take: MAX_WORK_ITEMS,
        select: {
          id: true,
          title: true,
          areaKey: true,
          status: true,
          ownerUserId: true,
          dueAt: true,
          caseId: true,
          objectType: true,
          objectId: true,
        },
      }),
    ]);

    const ownerIds = [...new Set(workItems.map((row) => row.ownerUserId))];
    const owners = ownerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true, username: true },
        })
      : [];
    const nameById = new Map(owners.map((row) => [row.id, row.name || row.username]));

    return NextResponse.json({
      computedAt: now.toISOString(),
      approvals,
      proposals: proposals.map((row) => ({
        id: row.id,
        summary: row.summary,
        toolName: row.toolName,
        status: row.status,
        effect: row.effect,
        approverScope: row.approverScope,
        userId: row.userId,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      })),
      workItems: workItems.map((row) => ({
        id: row.id,
        title: row.title,
        areaKey: row.areaKey,
        areaLabel: isAreaKey(row.areaKey) ? AREA_LABELS[row.areaKey] : row.areaKey,
        status: row.status,
        ownerUserId: row.ownerUserId,
        ownerName: nameById.get(row.ownerUserId) ?? null,
        dueAt: row.dueAt.toISOString(),
        overdue: row.dueAt.getTime() < now.getTime(),
        caseId: row.caseId,
        objectType: row.objectType,
        objectId: row.objectId,
      })),
    });
  } catch (error) {
    return controlTowerErrorResponse(error);
  }
}

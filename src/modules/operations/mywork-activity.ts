import { prisma } from '@/lib/prisma';
import { WORK_ITEM_OPEN_STATUSES } from './types';

/** Open work items of the user considered for the activity anchor (most urgent first). */
export const MYWORK_ACTIVITY_ITEMS = 200;

/**
 * "Mi trabajo" activity caused by OTHER people or the system (plan 5.2 anchor, anti-loop): the
 * latest operational event, not written by the AI layer, on the user's open work items (owner or
 * backup) whose actor is not the user. The user's own start/complete/wait/escalate never moves it,
 * so an action of the person never wakes their own copilot. `new Date(0)` when there is none.
 */
export async function myWorkOthersActivityAt(userId: string): Promise<Date> {
  if (!userId) return new Date(0);
  const items = await prisma.workItem.findMany({
    where: {
      OR: [{ ownerUserId: userId }, { backupUserId: userId }],
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
    },
    select: { id: true },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: MYWORK_ACTIVITY_ITEMS,
  });
  if (items.length === 0) return new Date(0);
  const last = await prisma.operationalEvent.findFirst({
    where: {
      objectType: 'work_item',
      objectId: { in: items.map((item) => item.id) },
      OR: [{ actorId: null }, { actorId: { not: userId } }],
      NOT: { type: { startsWith: 'ai.' } },
    },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
  return last?.occurredAt ?? new Date(0);
}

import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';

/**
 * Map of pending work and its dependencies for a user: approvals waiting on
 * them, skill runs paused on approvals, internal requests, commitments,
 * quotes awaiting approval/review and campaigns awaiting approval. Read-only
 * aggregation; each item links to where it is resolved.
 */

export interface PendingItem {
  kind: 'proposal' | 'skill_run' | 'request' | 'commitment' | 'quote' | 'campaign' | 'memory';
  id: string;
  title: string;
  detail: string | null;
  status: string;
  dueAt: string | null;
  createdAt: string;
  href: string;
  /** Ids of items this one is waiting on. */
  dependsOn: string[];
  blocking: boolean;
}

export async function buildPendingMap(
  actor: CurrentUser
): Promise<{ items: PendingItem[]; counts: Record<string, number> }> {
  const items: PendingItem[] = [];
  const now = new Date();

  const proposals = await prisma.aiProposal.findMany({
    where: {
      userId: actor.id,
      status: { in: ['pending', 'pending_review'] },
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  for (const p of proposals) {
    items.push({
      kind: 'proposal',
      id: p.id,
      title: `Aprobación: ${p.toolName}`,
      detail: p.summary,
      status: p.status,
      dueAt: p.expiresAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
      href: p.conversationId ? `/app/assistant?conversation=${p.conversationId}` : '/app/assistant',
      dependsOn: [],
      blocking: true,
    });
  }

  const runs = await prisma.skillRun.findMany({
    where: { userId: actor.id, status: 'waiting_approval' },
    include: { skill: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  for (const r of runs) {
    items.push({
      kind: 'skill_run',
      id: r.id,
      title: `Skill en espera: ${r.skill.name}`,
      detail: r.currentStep ? `Paso ${r.currentStep}` : null,
      status: r.status,
      dueAt: null,
      createdAt: r.createdAt.toISOString(),
      href: '/app/assistant/extensions',
      dependsOn: r.proposalId ? [r.proposalId] : [],
      blocking: false,
    });
  }

  const pendingMemories = await prisma.aiMemory.count({
    where: { userId: actor.id, status: 'pending' },
  });
  if (pendingMemories > 0) {
    items.push({
      kind: 'memory',
      id: 'memory',
      title: `${pendingMemories} recuerdo(s) propuestos por confirmar`,
      detail: null,
      status: 'pending',
      dueAt: null,
      createdAt: now.toISOString(),
      href: '/app/assistant',
      dependsOn: [],
      blocking: false,
    });
  }

  if (hasPermission(actor, 'requests.use')) {
    const requests = await prisma.internalRequest.findMany({
      where: {
        OR: [{ assigneeUserId: actor.id }, { requesterUserId: actor.id }],
        status: { in: ['open', 'in_progress', 'waiting'] },
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
    for (const r of requests) {
      items.push({
        kind: 'request',
        id: r.id,
        title: r.title,
        detail: `${r.type} · ${r.assigneeUserId === actor.id ? 'asignada a ti' : 'la solicitaste'}`,
        status: r.status,
        dueAt: r.dueAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        href: `/app/requests?id=${r.id}`,
        dependsOn: [],
        blocking: r.status === 'waiting',
      });
    }
  }

  const commitments = await prisma.commitment.findMany({
    where: { ownerUserId: actor.id, status: { in: ['pending', 'overdue'] } },
    orderBy: [{ dueAt: 'asc' }],
    take: 100,
  });
  for (const c of commitments) {
    items.push({
      kind: 'commitment',
      id: c.id,
      title: c.description,
      detail: c.sourceType,
      status: c.dueAt && c.dueAt < now ? 'overdue' : c.status,
      dueAt: c.dueAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      href: '/app/inbox',
      dependsOn: [],
      blocking: false,
    });
  }

  if (hasPermission(actor, 'quotes.use') || hasPermission(actor, 'quotes.approve')) {
    const quotes = await prisma.quote.findMany({
      where: {
        status: { in: ['pending_approval', 'invalidated'] },
        ...(hasPermission(actor, 'quotes.approve') ? {} : { createdBy: actor.id }),
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    for (const q of quotes) {
      items.push({
        kind: 'quote',
        id: q.id,
        title: `Cotización ${q.number ?? q.id.slice(0, 6)} · ${q.customerName}`,
        detail: q.invalidationReason ?? `Total ${q.total.toString()} ${q.currency}`,
        status: q.status,
        dueAt: null,
        createdAt: q.createdAt.toISOString(),
        href: `/app/quotes?id=${q.id}`,
        dependsOn: q.proposalId ? [q.proposalId] : [],
        blocking: q.status === 'pending_approval',
      });
    }
  }

  if (hasPermission(actor, 'campaigns.view')) {
    const campaigns = await prisma.campaign.findMany({
      where: { status: { in: ['pending_approval', 'paused'] } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    for (const c of campaigns) {
      items.push({
        kind: 'campaign',
        id: c.id,
        title: `Campaña ${c.name}`,
        detail:
          c.status === 'paused'
            ? 'Pausada (revisar presupuesto o bajas)'
            : 'Pendiente de aprobación',
        status: c.status,
        dueAt: c.scheduledAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        href: `/app/campaigns?id=${c.id}`,
        dependsOn: [],
        blocking: true,
      });
    }
  }

  const counts: Record<string, number> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  items.sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return ad - bd;
  });
  return { items, counts };
}

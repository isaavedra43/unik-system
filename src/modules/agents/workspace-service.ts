import { prisma } from '@/lib/prisma';
import { publishRealtime } from '@/modules/realtime/realtime-service';
import { DEFAULT_TENANT_ID } from './tenancy';

/**
 * Workspaces UNIVERSO (B6) — la "computadora" lógica. Como decidiste venue
 * CENTRAL: un Workspace `shared` por usuario (la venue Daytona existente); los
 * leases serializan qué RUN la está usando para que dos agentes no se pisen.
 *
 * - `venuePolicy='shared'`  → lease sobre el workspace central del dueño.
 * - `venuePolicy='dedicated'` → workspace propio del agente (mismo VenueSession).
 * - `venuePolicy='ephemeral'` → workspace por run, se libera al terminar.
 */

export interface WorkspaceHandle {
  workspaceId: string;
  leaseId: string;
  venueSessionId: string | null;
  /** true si hubo que esperar a que se liberara */
  queued: boolean;
}

async function wsTableReady(): Promise<boolean> {
  try {
    await prisma.workspace.findFirst({ select: { id: true } });
    return true;
  } catch {
    return false;
  }
}

/** Workspace central del usuario (o el dedicado del agente). Idempotente. */
export async function ensureWorkspace(
  userId: string,
  tenantId: string,
  agentId?: string | null,
  kind: 'shared' | 'dedicated' | 'ephemeral' = 'shared'
): Promise<{ id: string; venueSessionId: string | null } | null> {
  if (!(await wsTableReady())) return null;
  try {
    const found = await prisma.workspace.findFirst({
      where: { userId, tenantId: tenantId || DEFAULT_TENANT_ID, kind, agentId: kind === 'shared' ? null : (agentId ?? null) },
    });
    if (found) return { id: found.id, venueSessionId: found.venueSessionId };
    const created = await prisma.workspace.create({
      data: { userId, tenantId: tenantId || DEFAULT_TENANT_ID, kind, agentId: kind === 'shared' ? null : agentId },
    });
    return { id: created.id, venueSessionId: created.venueSessionId };
  } catch {
    return null;
  }
}

/** Lease activo sobre un workspace (quién la tiene ahora). */
export async function activeLease(workspaceId: string) {
  return prisma.workspaceLease.findFirst({
    where: { workspaceId, releasedAt: null },
    orderBy: { acquiredAt: 'asc' },
  }).catch(() => null);
}

/**
 * Toma el lease para un run. Si otro run la tiene, espera hasta `waitMs`
 * (default 90s) haciendo poll cada 2s — las tasks de agente toleran la cola.
 */
export async function acquireWorkspace(input: {
  userId: string;
  tenantId?: string;
  runId: string;
  agentId?: string | null;
  venuePolicy?: string;
  waitMs?: number;
}): Promise<WorkspaceHandle | null> {
  const kind = input.venuePolicy === 'dedicated' ? 'dedicated'
    : input.venuePolicy === 'ephemeral' ? 'ephemeral' : 'shared';
  const ws = await ensureWorkspace(input.userId, input.tenantId ?? DEFAULT_TENANT_ID, input.agentId, kind);
  if (!ws) return null;

  const deadline = Date.now() + (input.waitMs ?? 90_000);
  let queued = false;
  for (;;) {
    const current = await activeLease(ws.id);
    if (!current || current.agentRunId === input.runId) break;
    queued = true;
    if (Date.now() > deadline) return null; // cola saturada → el caller reintenta/falla
    await new Promise((r) => setTimeout(r, 2000));
  }

  const lease = await prisma.workspaceLease.create({
    data: { workspaceId: ws.id, agentRunId: input.runId, venueSessionId: ws.venueSessionId },
  }).catch(() => null);
  if (!lease) return null;

  await publishRealtime(`user:${input.userId}`, 'workspace.lease', {
    workspaceId: ws.id, leaseId: lease.id, runId: input.runId,
    agentId: input.agentId ?? null, action: 'acquired', queued,
  }).catch(() => null);
  return { workspaceId: ws.id, leaseId: lease.id, venueSessionId: ws.venueSessionId, queued };
}

/** Suelta el lease del run (idempotente). */
export async function releaseWorkspace(runId: string, userId?: string): Promise<void> {
  const res = await prisma.workspaceLease.updateMany({
    where: { agentRunId: runId, releasedAt: null },
    data: { releasedAt: new Date() },
  }).catch(() => ({ count: 0 }));
  if (res.count > 0 && userId) {
    await publishRealtime(`user:${userId}`, 'workspace.lease', {
      runId, action: 'released',
    }).catch(() => null);
  }
}

/** Estado del workspace central para el OpsPanel: dueño actual + cola. */
export async function workspaceStatus(userId: string, tenantId: string) {
  const ws = await prisma.workspace.findFirst({
    where: { userId, tenantId: tenantId || DEFAULT_TENANT_ID, kind: 'shared' },
  }).catch(() => null);
  if (!ws) return { workspace: null };
  const lease = await activeLease(ws.id);
  let owner: { runId: string; agentId: string | null; since: string } | null = null;
  if (lease) {
    const run = await prisma.agentRun.findUnique({
      where: { id: lease.agentRunId }, select: { agentId: true },
    }).catch(() => null);
    owner = { runId: lease.agentRunId, agentId: run?.agentId ?? null, since: lease.acquiredAt.toISOString() };
  }
  return {
    workspace: { id: ws.id, kind: ws.kind, venueSessionId: ws.venueSessionId },
    lease: owner,
  };
}

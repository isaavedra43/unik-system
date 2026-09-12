import { prisma } from '@/lib/prisma';

/**
 * Personal memory of the assistant: facts the user wants remembered.
 * Always visible, editable and deletable by its owner. Memories written by
 * the assistant (including corrections it learned) stay `pending` until the
 * user confirms them — controlled learning, never silent.
 */

const MAX_ACTIVE_IN_PROMPT = 30;
const MAX_CONTENT = 500;

export interface MemoryDTO {
  id: string;
  content: string;
  source: string;
  status: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

function toDTO(m: {
  id: string;
  content: string;
  source: string;
  status: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}): MemoryDTO {
  return {
    id: m.id,
    content: m.content,
    source: m.source,
    status: m.status,
    tags: m.tags,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
  };
}

function clean(content: string): string {
  const c = content.replace(/\s+/g, ' ').trim();
  if (c.length === 0) throw new Error('El recuerdo no puede estar vacío');
  return c.slice(0, MAX_CONTENT);
}

export async function listMemory(
  userId: string,
  options: { includeArchived?: boolean } = {}
): Promise<MemoryDTO[]> {
  const rows = await prisma.aiMemory.findMany({
    where: {
      userId,
      ...(options.includeArchived ? {} : { status: { in: ['active', 'pending'] } }),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  });
  return rows.map(toDTO);
}

export async function addMemory(
  userId: string,
  content: string,
  options: { source?: 'user' | 'assistant' | 'correction'; tags?: string[] } = {}
): Promise<MemoryDTO> {
  const source = options.source ?? 'user';
  const row = await prisma.aiMemory.create({
    data: {
      userId,
      content: clean(content),
      source,
      // Only the user can create an active memory directly; the assistant proposes.
      status: source === 'user' ? 'active' : 'pending',
      tags: (options.tags ?? []).slice(0, 10).map((t) => t.slice(0, 40)),
    },
  });
  return toDTO(row);
}

export async function updateMemory(
  userId: string,
  id: string,
  patch: { content?: string; tags?: string[] }
): Promise<MemoryDTO | null> {
  const existing = await prisma.aiMemory.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const row = await prisma.aiMemory.update({
    where: { id },
    data: {
      content: patch.content !== undefined ? clean(patch.content) : undefined,
      tags: patch.tags?.slice(0, 10).map((t) => t.slice(0, 40)),
    },
  });
  return toDTO(row);
}

/** Confirms a pending memory/correction (user decision) or rejects it. */
export async function decideMemory(
  userId: string,
  id: string,
  accept: boolean
): Promise<MemoryDTO | null> {
  const existing = await prisma.aiMemory.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const row = await prisma.aiMemory.update({
    where: { id },
    data: { status: accept ? 'active' : 'archived' },
  });
  return toDTO(row);
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const res = await prisma.aiMemory.deleteMany({ where: { id, userId } });
  return res.count > 0;
}

export async function clearMemory(userId: string): Promise<number> {
  const res = await prisma.aiMemory.deleteMany({ where: { userId } });
  return res.count;
}

/** Active memories for the prompt (most recent first, bounded). Marks them as used. */
export async function getMemoryForPrompt(userId: string): Promise<string[]> {
  const rows = await prisma.aiMemory.findMany({
    where: { userId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
    take: MAX_ACTIVE_IN_PROMPT,
    select: { id: true, content: true },
  });
  if (rows.length > 0) {
    await prisma.aiMemory
      .updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
  }
  return rows.map((r) => r.content);
}

/** Prompt fragment. Pure. */
export function buildMemoryPrompt(memories: string[], pendingCount: number): string {
  if (memories.length === 0 && pendingCount === 0) return '';
  const lines = ['## Memoria personal del usuario (visible y editable por él)'];
  for (const m of memories) lines.push(`- ${m}`);
  if (pendingCount > 0) {
    lines.push(
      `- (Hay ${pendingCount} recuerdo(s) propuestos pendientes de que el usuario los confirme; no los uses como hechos.)`
    );
  }
  lines.push(
    '- Cuando el usuario te corrija un dato o preferencia estable, usa la herramienta rememberForUser: quedará PENDIENTE hasta que él lo confirme.'
  );
  return lines.join('\n');
}

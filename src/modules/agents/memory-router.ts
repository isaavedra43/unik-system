import { prisma } from '@/lib/prisma';
import { DEFAULT_TENANT_ID } from './tenancy';

/**
 * MemoryRouter (B8) — qué memoria entra al prompt de cada agente.
 *
 * Scopes (ya en el schema): tenantId → userId → agentId → conversationId.
 * Modos por agente (Hermes): 'full' = inyección automática, 'on_demand' =
 * solo cuando la tool de búsqueda la pida, 'off' = cero memoria (workers
 * transitorios con datos sensibles).
 *
 * Reglas duras:
 * - NUNCA se inyecta memoria de otro tenant.
 * - Lo del usuario (preferencias, hechos confirmados) siempre disponible para
 *   sus agentes; lo de un agente especialista solo para ese agente.
 * - Presupuesto de tokens acotado — memoria es contexto, no historial.
 */

export type MemoryMode = 'full' | 'on_demand' | 'off';
const MAX_FACTS = 12;
const MAX_EPISODES = 6;

export interface RecallInput {
  userId: string;
  tenantId?: string;
  agentId?: string | null;
  conversationId?: string | null;
  mode?: MemoryMode;
}

/** Memoria que se inyecta automáticamente al system prompt del agente. */
export async function recallFor(input: RecallInput): Promise<string> {
  if (input.mode === 'off') return '';
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;

  const [facts, episodes] = await Promise.all([
    prisma.agentFact.findMany({
      where: {
        tenantId,
        OR: [
          { userId: input.userId, agentId: null },
          ...(input.agentId ? [{ userId: input.userId, agentId: input.agentId }] : []),
        ],
        status: 'active',
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_FACTS,
    }).catch(() => [] as Array<{ entity: string; attribute: string; value: string }>),
    input.agentId
      ? prisma.agentEpisode.findMany({
          where: { tenantId, userId: input.userId, agentId: input.agentId },
          orderBy: { importance: 'desc' },
          take: MAX_EPISODES,
        }).catch(() => [] as Array<{ summary: string }>)
      : Promise.resolve([] as Array<{ summary: string }>),
  ]);

  const lines: string[] = [];
  if (facts.length > 0) {
    lines.push('Hechos confirmados:');
    for (const f of facts) lines.push(`- ${f.entity} · ${f.attribute}: ${f.value}`);
  }
  if (episodes.length > 0) {
    lines.push('Episodios relevantes de este agente:');
    for (const e of episodes) lines.push(`- ${e.summary}`);
  }
  return lines.join('\n');
}

/** Búsqueda on_demand (la tool memory_search la llama con el query del modelo). */
export async function searchMemory(input: RecallInput & { query: string }): Promise<Array<{ kind: string; text: string }>> {
  if (input.mode === 'off' || !input.query.trim()) return [];
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const q = input.query.trim();
  const facts = await prisma.agentFact.findMany({
    where: {
      tenantId,
      userId: input.userId,
      OR: [
        { entity: { contains: q, mode: 'insensitive' } },
        { value: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 10,
  }).catch(() => [] as Array<{ entity: string; attribute: string; value: string }>);
  return facts.map((f) => ({ kind: 'fact', text: `${f.entity} · ${f.attribute}: ${f.value}` }));
}

/** Guarda un hecho en el scope correcto (el user siempre dueño; agentId opcional). */
export async function rememberFact(input: {
  userId: string;
  tenantId?: string;
  agentId?: string | null;
  fact: string;
  source?: string;
  confidence?: number;
}): Promise<void> {
  const raw = input.fact.trim().slice(0, 500);
  if (!raw) return;
  // entity·attribute: value — si no hay ':' va todo a value.
  const [head, ...rest] = raw.split(':');
  const [entity, attribute] = head.includes('·')
    ? head.split('·').map((s) => s.trim())
    : [head.trim(), 'nota'];
  await prisma.agentFact.create({
    data: {
      userId: input.userId,
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID,
      agentId: input.agentId ?? null,
      entity: entity.slice(0, 160) || 'nota',
      attribute: (attribute || 'nota').slice(0, 80),
      value: (rest.join(':').trim() || raw).slice(0, 500),
      source: input.source ?? 'agent',
      confidence: input.confidence ?? 0.8,
      status: 'pending',
    },
  }).catch(() => null);
}

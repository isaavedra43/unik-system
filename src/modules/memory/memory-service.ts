import { prisma } from '@/lib/prisma';
import { embedQuery, embedTexts } from '@/modules/ai/embeddings-service';
import { normalizeText } from '@/modules/ai/tool-selector';

/**
 * Agent memory — three layers behind one service:
 *
 * - EPISODIC  (AgentEpisode):  every meaningful turn distilled to a searchable
 *   summary with an embedding. "The agent remembers what happened."
 * - SEMANTIC  (AgentFact):     durable facts about the business/user. Anything
 *   the agent extracts arrives `pending` until the user confirms — controlled
 *   learning, same contract as AiMemory.
 * - PROCEDURAL(AgentPlaybook): tool-arg patterns that worked. "For 'efectivo'
 *   this user expects EFECTIVO + EFECTIVO EN BODEGA" — learned from real use.
 *
 * Vectors are Float[] compared with cosine in-app (same pattern as
 * KnowledgeChunk) — no pgvector needed. The interface stays swappable: a
 * managed store (Zep/mem0) could replace this without touching callers.
 */

const EPISODE_POOL = 600; // most recent episodes considered for recall
const FACT_POOL = 200;
const PLAYBOOK_POOL = 100;
const MAX_SUMMARY = 400;

// ---------------------------------------------------------------------------
// Similarity helpers (pure — unit tested)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Days old → 1 fresh … 0 stale (half-life ≈ 14 days). */
function recencyScore(createdAt: Date): number {
  const days = (Date.now() - createdAt.getTime()) / 86_400_000;
  return Math.exp(-days / 20);
}

function stems(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((w) => w.length > 3)
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / Math.min(a.size, b.size);
}

// ---------------------------------------------------------------------------
// Episodic memory
// ---------------------------------------------------------------------------

export interface EpisodeInput {
  conversationId?: string | null;
  summary: string;
  entities?: string[];
  toolNames?: string[];
  importance?: number;
}

export async function recordEpisode(userId: string, input: EpisodeInput): Promise<void> {
  const summary = input.summary.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
  if (summary.length < 8) return;
  const embedded = await embedTexts([summary]).catch(() => null);
  await prisma.agentEpisode.create({
    data: {
      userId,
      conversationId: input.conversationId ?? null,
      summary,
      embedding: embedded?.vectors[0] ?? [],
      entities: (input.entities ?? []).slice(0, 20).map((e) => e.slice(0, 80)),
      toolNames: (input.toolNames ?? []).slice(0, 20),
      importance: Math.max(1, Math.min(10, Math.round(input.importance ?? 5))),
    },
  });
}

export interface RecalledEpisode {
  summary: string;
  createdAt: Date;
  score: number;
}

export async function recallEpisodes(
  userId: string,
  message: string,
  opts: { limit?: number } = {}
): Promise<RecalledEpisode[]> {
  const limit = opts.limit ?? 4;
  const rows = await prisma.agentEpisode.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: EPISODE_POOL,
    select: { summary: true, entities: true, importance: true, createdAt: true, embedding: true },
  });
  if (rows.length === 0) return [];

  const queryVec = await embedQuery(message).catch(() => null);
  const messageStems = stems(message);

  const scored = rows.map((r) => {
    const semantic = queryVec ? cosineSimilarity(queryVec, r.embedding) : 0;
    const keyword = overlapScore(messageStems, stems(r.entities.join(' ') + ' ' + r.summary));
    const score = semantic * 0.45 + keyword * 0.25 + recencyScore(r.createdAt) * 0.15 + (r.importance / 10) * 0.15;
    return { summary: r.summary, createdAt: r.createdAt, score };
  });
  return scored
    .filter((s) => s.score > 0.18)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Semantic memory (facts)
// ---------------------------------------------------------------------------

export interface FactInput {
  entity: string;
  attribute: string;
  value: string;
  confidence?: number;
  source?: 'user' | 'tool' | 'observation' | 'correction';
  sourceRef?: string | null;
}

const normKey = (s: string) => normalizeText(s).replace(/\s+/g, ' ').trim();

/** Near-duplicate detection between a candidate fact and existing ones. */
function sameFact(a: { entity: string; attribute: string }, entity: string, attribute: string): boolean {
  return normKey(a.entity) === normKey(entity) && normKey(a.attribute) === normKey(attribute);
}

/**
 * Proposes a fact. User-sourced facts activate immediately; everything else
 * arrives `pending` for confirmation. Duplicates update confidence/lastSeen
 * instead of creating noise.
 */
export async function proposeFact(userId: string, input: FactInput): Promise<'created' | 'updated' | 'duplicate'> {
  const entity = input.entity.slice(0, 120);
  const attribute = input.attribute.slice(0, 80);
  const value = input.value.slice(0, 300);
  if (!entity || !attribute || !value) return 'duplicate';

  const existing = await prisma.agentFact.findMany({
    where: { userId, status: { not: 'archived' } },
    select: { id: true, entity: true, attribute: true, value: true, status: true, confidence: true },
    take: FACT_POOL,
  });
  const dupe = existing.find((f) => sameFact(f, entity, attribute));
  if (dupe) {
    if (normKey(dupe.value) === normKey(value)) return 'duplicate';
    // Same entity+attribute, new value: update in place (keep pending status if unconfirmed).
    await prisma.agentFact.update({
      where: { id: dupe.id },
      data: { value, confidence: Math.max(dupe.confidence, input.confidence ?? 0.7) },
    });
    return 'updated';
  }

  await prisma.agentFact.create({
    data: {
      userId,
      entity,
      attribute,
      value,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)),
      source: input.source ?? 'observation',
      sourceRef: input.sourceRef ?? null,
      status: input.source === 'user' ? 'active' : 'pending',
    },
  });
  return 'created';
}

export async function recallFacts(
  userId: string,
  message: string,
  opts: { limit?: number } = {}
): Promise<Array<{ entity: string; attribute: string; value: string }>> {
  const rows = await prisma.agentFact.findMany({
    where: { userId, status: 'active' },
    orderBy: { lastConfirmedAt: 'desc' },
    take: FACT_POOL,
    select: { entity: true, attribute: true, value: true, confidence: true },
  });
  if (rows.length === 0) return [];
  // Few facts → all of them in context. Many → the ones relevant to this message first.
  if (rows.length <= (opts.limit ?? 8)) return rows;
  const messageStems = stems(message);
  const scored = rows.map((f) => ({
    f,
    score: overlapScore(messageStems, stems(`${f.entity} ${f.attribute} ${f.value}`)) + f.confidence * 0.1,
  }));
  return scored
    .filter((s) => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 8)
    .map((s) => s.f);
}

export async function decideFact(userId: string, id: string, accept: boolean): Promise<boolean> {
  const res = await prisma.agentFact.updateMany({
    where: { id, userId },
    data: { status: accept ? 'active' : 'archived', lastConfirmedAt: accept ? new Date() : undefined },
  });
  return res.count > 0;
}

// ---------------------------------------------------------------------------
// Procedural memory (playbooks)
// ---------------------------------------------------------------------------

export interface PlaybookInput {
  trigger: string;
  toolName: string;
  argsTemplate: Record<string, unknown>;
  note?: string;
}

export async function recordPlaybook(userId: string, input: PlaybookInput): Promise<void> {
  const trigger = normKey(input.trigger).slice(0, 160);
  if (!trigger || !input.toolName) return;
  const existing = await prisma.agentPlaybook.findMany({
    where: { userId, toolName: input.toolName },
    take: PLAYBOOK_POOL,
    select: { id: true, trigger: true, successCount: true },
  });
  const match = existing.find((p) => overlapScore(stems(p.trigger), stems(trigger)) >= 0.7);
  if (match) {
    await prisma.agentPlaybook.update({
      where: { id: match.id },
      data: {
        argsTemplate: input.argsTemplate as never,
        successCount: match.successCount + 1,
        lastUsedAt: new Date(),
        note: input.note ?? undefined,
      },
    });
    return;
  }
  await prisma.agentPlaybook.create({
    data: {
      userId,
      trigger,
      toolName: input.toolName,
      argsTemplate: input.argsTemplate as never,
      note: input.note?.slice(0, 200) ?? null,
    },
  });
}

export async function matchPlaybooks(
  userId: string,
  message: string,
  opts: { limit?: number } = {}
): Promise<Array<{ trigger: string; toolName: string; argsTemplate: Record<string, unknown>; note: string | null }>> {
  const rows = await prisma.agentPlaybook.findMany({
    where: { userId, successCount: { gt: 0 } },
    orderBy: [{ successCount: 'desc' }, { lastUsedAt: 'desc' }],
    take: PLAYBOOK_POOL,
    select: { trigger: true, toolName: true, argsTemplate: true, note: true, successCount: true },
  });
  const messageStems = stems(message);
  return rows
    .map((p) => ({ p, score: overlapScore(messageStems, stems(p.trigger)) }))
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.p.successCount - a.p.successCount)
    .slice(0, opts.limit ?? 3)
    .map((s) => ({
      trigger: s.p.trigger,
      toolName: s.p.toolName,
      argsTemplate: s.p.argsTemplate as Record<string, unknown>,
      note: s.p.note,
    }));
}

// ---------------------------------------------------------------------------
// Recall — the prompt block injected on every turn
// ---------------------------------------------------------------------------

export async function buildRecallBlock(userId: string, message: string): Promise<string> {
  const [episodes, facts, playbooks] = await Promise.all([
    recallEpisodes(userId, message).catch(() => []),
    recallFacts(userId, message).catch(() => []),
    matchPlaybooks(userId, message).catch(() => []),
  ]);
  if (episodes.length === 0 && facts.length === 0 && playbooks.length === 0) return '';

  const lines = ['## MEMORIA DEL AGENTE (recuperada para este mensaje)'];
  if (facts.length > 0) {
    lines.push('**Hechos confirmados:**');
    for (const f of facts) lines.push(`- ${f.entity} · ${f.attribute}: ${f.value}`);
  }
  if (episodes.length > 0) {
    lines.push('**Episodios relevantes:**');
    for (const e of episodes) {
      const days = Math.round((Date.now() - e.createdAt.getTime()) / 86_400_000);
      const ago = days === 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`;
      lines.push(`- (${ago}) ${e.summary}`);
    }
  }
  if (playbooks.length > 0) {
    lines.push('**Patrones que funcionaron para este usuario** (úsalo como punto de partida de los args, verifica igual):');
    for (const p of playbooks) {
      lines.push(`- "${p.trigger}" → ${p.toolName}(${JSON.stringify(p.argsTemplate)})${p.note ? ` — ${p.note}` : ''}`);
    }
  }
  lines.push('La memoria orienta; los datos vivos SIEMPRE se consultan con tools. Si memoria y datos difieren, ganan los datos.');
  return lines.join('\n');
}

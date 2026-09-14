import OpenAI from 'openai';
import { prisma } from '@/lib/prisma';
import { getAiSettings } from './ai-admin-config-service';
import { getProviderConfig } from './ai-config';

/**
 * Embeddings for the approved knowledge library (semantic RAG).
 *
 * Vectors are stored in `KnowledgeChunk.embedding` (double precision[]) and
 * compared with cosine similarity in the app — no Postgres extension needed,
 * which keeps Railway/local setups identical. The corpus (a company's manuals,
 * policies, product sheets) is small enough for this to be instant; pgvector
 * can be added later without changing callers.
 */

const BATCH_SIZE = 64;
const MAX_INPUT_CHARS = 6000;

let client: OpenAI | null = null;
let clientKey = '';

async function getEmbeddingsClient(): Promise<{ client: OpenAI; model: string } | null> {
  const [settings, config] = await Promise.all([getAiSettings(), getProviderConfig('openai')]);
  if (!settings.ragSemanticEnabled || !config.apiKey) return null;
  const key = `${config.apiKey}|${config.endpoint ?? ''}`;
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: config.apiKey, ...(config.endpoint ? { baseURL: config.endpoint } : {}) });
    clientKey = key;
  }
  return { client, model: settings.embeddingModel?.trim() || 'text-embedding-3-small' };
}

export async function isEmbeddingsAvailable(): Promise<boolean> {
  return (await getEmbeddingsClient()) !== null;
}

/** Embeds texts in batches. Returns [] when embeddings are not configured. */
export async function embedTexts(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
  const ctx = await getEmbeddingsClient();
  if (!ctx || texts.length === 0) return null;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS) || ' ');
    const res = await ctx.client.embeddings.create({ model: ctx.model, input: batch });
    const ordered = [...res.data].sort((a, b) => a.index - b.index);
    for (const row of ordered) vectors.push(row.embedding);
  }
  return { vectors, model: ctx.model };
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const res = await embedTexts([text]);
  return res?.vectors[0] ?? null;
}

/** Computes and stores the vectors of every chunk of a version (idempotent, skips embedded ones). */
export async function embedVersionChunks(versionId: string): Promise<{ embedded: number; skipped: boolean }> {
  const ctx = await getEmbeddingsClient();
  if (!ctx) return { embedded: 0, skipped: true };
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { versionId, embeddingModel: null },
    select: { id: true, content: true, section: true },
    orderBy: { ordinal: 'asc' },
  });
  if (chunks.length === 0) return { embedded: 0, skipped: false };
  const res = await embedTexts(chunks.map((c) => (c.section ? `${c.section}\n${c.content}` : c.content)));
  if (!res) return { embedded: 0, skipped: true };
  for (let i = 0; i < chunks.length; i += 50) {
    const slice = chunks.slice(i, i + 50);
    await prisma.$transaction(
      slice.map((c, j) =>
        prisma.knowledgeChunk.update({
          where: { id: c.id },
          data: { embedding: res.vectors[i + j], embeddingModel: res.model },
        })
      )
    );
  }
  return { embedded: chunks.length, skipped: false };
}

/** Background backfill: embeds chunks of approved, ready versions that have no vector yet. */
export async function backfillEmbeddings(limit = 400): Promise<{ embedded: number; versions: number }> {
  const ctx = await getEmbeddingsClient();
  if (!ctx) return { embedded: 0, versions: 0 };
  const pending = await prisma.knowledgeChunk.findMany({
    where: { embeddingModel: null, version: { status: 'ready' } },
    select: { versionId: true },
    distinct: ['versionId'],
    take: 20,
  });
  let embedded = 0;
  let budget = limit;
  for (const row of pending) {
    if (budget <= 0) break;
    const res = await embedVersionChunks(row.versionId).catch((err) => {
      console.warn(JSON.stringify({ event: 'ai.embeddings.version_failed', versionId: row.versionId, message: err instanceof Error ? err.message : 'unknown' }));
      return { embedded: 0, skipped: true };
    });
    embedded += res.embedded;
    budget -= Math.max(1, res.embedded);
  }
  return { embedded, versions: pending.length };
}

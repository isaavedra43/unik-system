import { EventEmitter } from 'events';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Persisted realtime events with cursor recovery.
 *
 * `publishRealtime` writes the event to PostgreSQL (durable, shared across
 * instances) and emits it in-process for low-latency delivery. The SSE
 * endpoint replays everything after the client's cursor (`Last-Event-ID`)
 * and then polls the table, so a reconnect never loses an update.
 */

export interface RealtimeEventRecord {
  id: string; // BigInt serialized
  channel: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

type GlobalWithEmitter = typeof globalThis & { __unikRealtimeEmitter?: EventEmitter };

function emitter(): EventEmitter {
  const scope = globalThis as GlobalWithEmitter;
  if (!scope.__unikRealtimeEmitter) {
    scope.__unikRealtimeEmitter = new EventEmitter();
    scope.__unikRealtimeEmitter.setMaxListeners(1000);
  }
  return scope.__unikRealtimeEmitter;
}

export const REALTIME_CHANNELS = {
  user: (userId: string) => `user:${userId}`,
  upload: (objectId: string) => `upload:${objectId}`,
  job: (jobId: string) => `job:${jobId}`,
  inbox: (scope: string) => `inbox:${scope}`,
  call: (callId: string) => `call:${callId}`,
  campaign: (campaignId: string) => `campaign:${campaignId}`,
} as const;

export async function publishRealtime(
  channel: string,
  type: string,
  payload: unknown
): Promise<RealtimeEventRecord> {
  const row = await prisma.realtimeEvent.create({
    data: { channel, type, payload: (payload ?? {}) as Prisma.InputJsonValue },
  });
  const record: RealtimeEventRecord = {
    id: row.id.toString(),
    channel: row.channel,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
  emitter().emit('event', record);
  return record;
}

export function subscribeRealtime(
  channels: string[],
  listener: (event: RealtimeEventRecord) => void
): () => void {
  const set = new Set(channels);
  const handler = (event: RealtimeEventRecord) => {
    if (set.has(event.channel)) listener(event);
  };
  emitter().on('event', handler);
  return () => emitter().off('event', handler);
}

export async function readRealtimeSince(
  channels: string[],
  afterId: bigint,
  limit = 200
): Promise<RealtimeEventRecord[]> {
  if (channels.length === 0) return [];
  const rows = await prisma.realtimeEvent.findMany({
    where: { channel: { in: channels }, id: { gt: afterId } },
    orderBy: { id: 'asc' },
    take: Math.min(limit, 500),
  });
  return rows.map((row) => ({
    id: row.id.toString(),
    channel: row.channel,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function latestRealtimeId(): Promise<bigint> {
  const row = await prisma.realtimeEvent.findFirst({
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return row?.id ?? BigInt(0);
}

/** Retention: events older than `days` are removed (clients cannot resume that far anyway). */
export async function pruneRealtimeEvents(days = 3): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await prisma.realtimeEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}

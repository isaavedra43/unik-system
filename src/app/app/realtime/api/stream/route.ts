import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import {
  latestRealtimeId,
  readRealtimeSince,
  subscribeRealtime,
  type RealtimeEventRecord,
} from '@/modules/realtime/realtime-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_MS = 2000;
const HEARTBEAT_MS = 15000;

/**
 * GET /app/realtime/api/stream?channels=a,b&cursor=123
 *
 * Generic SSE endpoint over persisted events. The client resumes with the
 * last event id (query `cursor` or the `Last-Event-ID` header) and receives
 * everything it missed, then live updates (in-process emitter + DB polling
 * so several instances stay consistent).
 *
 * Channel authorization is resolved per channel; unknown or unauthorized
 * channels are silently dropped.
 */
async function authorizeChannel(user: CurrentUser, channel: string): Promise<boolean> {
  const [kind, id] = channel.split(':', 2);
  if (!kind || !id) return false;
  switch (kind) {
    case 'user':
      return id === user.id;
    case 'upload': {
      const session = await prisma.uploadSession.findUnique({
        where: { objectId: id },
        select: { userId: true },
      });
      return session?.userId === user.id || hasPermission(user, 'files.admin');
    }
    case 'job': {
      const job = await prisma.backgroundJob.findUnique({
        where: { id },
        select: { createdBy: true },
      });
      return job?.createdBy === user.id || hasPermission(user, 'files.admin');
    }
    case 'inbox':
      return hasPermission(user, 'inbox.use');
    case 'call':
      return hasPermission(user, 'calls.use');
    case 'campaign':
      return hasPermission(user, 'campaigns.view');
    default:
      return false;
  }
}

export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });

  const requested = (request.nextUrl.searchParams.get('channels') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.length < 120)
    .slice(0, 20);
  const channels: string[] = [];
  for (const channel of requested) {
    try {
      if (await authorizeChannel(session.user, channel)) channels.push(channel);
    } catch {
      // unknown permission keys (module not installed) simply deny
    }
  }
  if (channels.length === 0) {
    return NextResponse.json({ error: 'Sin canales autorizados' }, { status: 403 });
  }

  const cursorParam =
    request.nextUrl.searchParams.get('cursor') ?? request.headers.get('last-event-id');
  let cursor: bigint;
  try {
    cursor = cursorParam ? BigInt(cursorParam) : await latestRealtimeId();
  } catch {
    cursor = await latestRealtimeId();
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: RealtimeEventRecord | { id?: string; type: string; data: unknown }) => {
        if (closed) return;
        const id = 'id' in event && event.id ? `id: ${event.id}\n` : '';
        const payload =
          'payload' in event
            ? {
                channel: event.channel,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt,
              }
            : event.data;
        try {
          controller.enqueue(
            encoder.encode(`${id}event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      const deliver = (event: RealtimeEventRecord) => {
        const eventId = BigInt(event.id);
        if (eventId <= cursor) return;
        cursor = eventId;
        send(event);
      };

      send({ type: 'ready', data: { cursor: cursor.toString(), channels } });

      // Replay anything missed since the cursor, then subscribe.
      try {
        const missed = await readRealtimeSince(channels, cursor, 500);
        for (const event of missed) deliver(event);
      } catch {
        // continue with live events
      }
      const unsubscribe = subscribeRealtime(channels, deliver);

      const poll = setInterval(async () => {
        if (closed) return;
        try {
          const events = await readRealtimeSince(channels, cursor, 200);
          for (const event of events) deliver(event);
        } catch {
          // ignore transient DB errors
        }
      }, POLL_MS);
      const heartbeat = setInterval(
        () => send({ type: 'heartbeat', data: { t: Date.now() } }),
        HEARTBEAT_MS
      );

      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe();
        clearInterval(poll);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

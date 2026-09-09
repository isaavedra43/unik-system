import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getMessagesSince, assertChannelMember, getTypingUsers } from '@/modules/chat/chat-service';
import { getPresence } from '@/modules/chat/chat-presence-service';
import type { ChatStreamEvent } from '@/modules/chat/chat-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * SSE endpoint for real-time chat updates.
 *
 * Polls the database every 2 seconds for new messages, reactions, edits,
 * deletes, and presence changes in the channel. Emits SSE events to the
 * client. This approach works without Redis and across multiple Railway
 * instances (with up to 2s latency).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'chat.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const { id: channelId } = await params;

  try {
    await assertChannelMember(channelId, session.user.id);
  } catch {
    return NextResponse.json({ error: 'No eres miembro de este canal' }, { status: 403 });
  }

  const encoder = new TextEncoder();
  let lastPoll = new Date();
  let lastTypingCheck = Date.now();
  let lastPresenceCheck = Date.now();
  const knownTyping = new Set<string>();
  let lastPresenceStatuses = new Map<string, string>();

  // Get initial member IDs for presence tracking
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      const sendEvent = (event: ChatStreamEvent) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Send initial heartbeat
      sendEvent({ type: 'heartbeat', data: { t: Date.now() } });

      const interval = setInterval(async () => {
        if (closed) return;
        try {
          // Poll for new messages
          const messages = await getMessagesSince(channelId, session.user.id, lastPoll);
          if (messages.length > 0) {
            lastPoll = new Date();
            for (const msg of messages) {
              sendEvent({ type: 'message', data: msg });
            }
          }

          // Check typing indicators (every second poll)
          if (Date.now() - lastTypingCheck > 1000) {
            lastTypingCheck = Date.now();
            const typing = getTypingUsers(channelId);
            const currentTyping = new Set(
              typing.map((t) => t.userId).filter((uid) => uid !== session.user.id)
            );

            // New typing
            for (const uid of currentTyping) {
              if (!knownTyping.has(uid)) {
                knownTyping.add(uid);
                const user = await getUserName(uid);
                sendEvent({
                  type: 'typing',
                  data: { channelId, userId: uid, userName: user, isTyping: true },
                });
              }
            }

            // Stopped typing
            for (const uid of knownTyping) {
              if (!currentTyping.has(uid)) {
                knownTyping.delete(uid);
                const user = await getUserName(uid);
                sendEvent({
                  type: 'typing',
                  data: { channelId, userId: uid, userName: user, isTyping: false },
                });
              }
            }
          }

          // Check presence changes (every 5 seconds)
          if (Date.now() - lastPresenceCheck > 5000) {
            lastPresenceCheck = Date.now();
            const memberIds = await getChannelMemberIds(channelId);
            const presenceMap = await getPresence(memberIds);
            for (const [uid, status] of presenceMap) {
              const prev = lastPresenceStatuses.get(uid);
              if (prev !== status) {
                sendEvent({
                  type: 'presence',
                  data: { userId: uid, status, lastSeenAt: new Date().toISOString() },
                });
              }
            }
            lastPresenceStatuses = presenceMap;
          }
        } catch {
          // ignore poll errors, keep going
        }
      }, POLL_INTERVAL_MS);

      // Heartbeat to keep connection alive
      const heartbeatInterval = setInterval(() => {
        if (closed) return;
        sendEvent({ type: 'heartbeat', data: { t: Date.now() } });
      }, HEARTBEAT_INTERVAL_MS);

      // Cleanup on abort
      _request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeatInterval);
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

// Helper: cache user names to avoid repeated queries
const userNameCache = new Map<string, string>();
async function getUserName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  const { prisma } = await import('@/lib/prisma');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const name = user?.name ?? 'Usuario';
  userNameCache.set(userId, name);
  return name;
}

async function getChannelMemberIds(channelId: string): Promise<string[]> {
  const { prisma } = await import('@/lib/prisma');
  const members = await prisma.internalChatMember.findMany({
    where: { channelId, leftAt: null },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

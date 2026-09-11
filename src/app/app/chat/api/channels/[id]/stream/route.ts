import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getMessagesSince, assertChannelMember, getTypingUsers } from '@/modules/chat/chat-service';
import { getPresence } from '@/modules/chat/chat-presence-service';
import { getActiveCall } from '@/modules/chat/chat-calls-service';
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
 *
 * Also polls for active calls in the channel (call invites and call ends).
 * WebRTC signaling is handled directly by the ChatCallDialog via the signal
 * API, NOT through this SSE stream, to avoid signals being consumed before
 * the dialog can process them.
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
  let lastCallCheck = Date.now();
  let lastReadReceiptCheck = Date.now();
  const knownTyping = new Map<string, string | undefined>(); // userId -> preview
  let lastPresenceStatuses = new Map<string, string>();
  let knownCallId: string | null = null;
  // Track the latest readAt we've seen for each user to detect new receipts
  const knownReadReceipts = new Map<string, Date>(); // userId -> latest readAt

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
            const currentTyping = new Map<string, string | undefined>();
            for (const t of typing) {
              if (t.userId !== session.user.id) {
                currentTyping.set(t.userId, t.preview);
              }
            }

            // New typing or preview changed
            for (const [uid, preview] of currentTyping) {
              const knownPreview = knownTyping.get(uid);
              if (!knownTyping.has(uid) || knownPreview !== preview) {
                knownTyping.set(uid, preview);
                const user = await getUserName(uid);
                sendEvent({
                  type: 'typing',
                  data: { channelId, userId: uid, userName: user, isTyping: true, preview },
                });
              }
            }

            // Stopped typing
            for (const [uid] of knownTyping) {
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

          // Check for active calls (every 2 seconds)
          if (Date.now() - lastCallCheck > 2000) {
            lastCallCheck = Date.now();
            const activeCall = await getActiveCall(channelId);
            const currentCallId = activeCall?.id ?? null;

            if (currentCallId !== knownCallId) {
              if (activeCall) {
                // New or changed call
                sendEvent({ type: 'call_invite', data: activeCall });
              } else if (knownCallId) {
                // Call ended
                sendEvent({
                  type: 'call_end',
                  data: { callId: knownCallId, status: 'ended' },
                });
              }
              knownCallId = currentCallId;
            }
          }

          // NOTE: WebRTC signal polling is intentionally NOT done here.
          // The ChatCallDialog polls for signals directly via the signal
          // API (/app/chat/api/calls/[id]/signal). If the SSE stream also
          // polled for signals, it would mark them as delivered before the
          // ChatCallDialog could process them, breaking the WebRTC
          // connection handshake.

          // Check for new read receipts (every 3 seconds)
          // This powers the "seen" check marks on the sender's messages.
          if (Date.now() - lastReadReceiptCheck > 3000) {
            lastReadReceiptCheck = Date.now();
            const newReceipts = await getNewReadReceipts(channelId, session.user.id, knownReadReceipts);
            if (newReceipts.length > 0) {
              // Group by userId and emit events
              const byUser = new Map<string, string[]>();
              for (const r of newReceipts) {
                const arr = byUser.get(r.userId) ?? [];
                arr.push(r.messageId);
                byUser.set(r.userId, arr);
              }
              for (const [userId, messageIds] of byUser) {
                sendEvent({
                  type: 'read_update',
                  data: { channelId, messageIds, userId },
                });
              }
            }
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

/**
 * Find new read receipts from other users in the channel.
 * Updates the knownReadReceipts map in-place and returns the new receipts.
 */
async function getNewReadReceipts(
  channelId: string,
  currentUserId: string,
  knownReadReceipts: Map<string, Date>
): Promise<{ messageId: string; userId: string }[]> {
  const { prisma } = await import('@/lib/prisma');

  // Find the latest readAt per user in this channel (excluding current user)
  const receipts = await prisma.internalChatReadReceipt.findMany({
    where: {
      userId: { not: currentUserId },
      message: { channelId },
    },
    select: {
      messageId: true,
      userId: true,
      readAt: true,
    },
    orderBy: { readAt: 'desc' },
  });

  const newReceipts: { messageId: string; userId: string }[] = [];
  const seenInThisPoll = new Set<string>();

  for (const r of receipts) {
    const key = `${r.userId}:${r.messageId}`;
    if (seenInThisPoll.has(key)) continue;
    seenInThisPoll.add(key);

    const knownLatest = knownReadReceipts.get(r.userId);
    if (!knownLatest || r.readAt > knownLatest) {
      newReceipts.push({ messageId: r.messageId, userId: r.userId });
      if (!knownLatest || r.readAt > knownLatest) {
        knownReadReceipts.set(r.userId, r.readAt);
      }
    }
  }

  return newReceipts;
}

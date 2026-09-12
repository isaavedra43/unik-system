import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getChannelAdapter } from '@/modules/comms/adapters';
import { recordInboundMessage } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/telegram/[accountId]
 *
 * Telegram Bot API updates. Authenticated with the secret token configured
 * in `setWebhook` (sha256 stored on the account, constant-time compare).
 * Idempotent on "<chatId>:<messageId>"; media is fetched later by the
 * `comms.process_inbound` job.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;
  const account = await prisma.commAccount.findUnique({ where: { id: accountId } });
  if (!account || account.provider !== 'telegram') {
    return NextResponse.json({ error: 'Cuenta no encontrada' }, { status: 404 });
  }
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const parsed = await getChannelAdapter('telegram').parseWebhook(account, {
    headers,
    rawBody,
    url: request.url,
  });
  if (!parsed) return NextResponse.json({ error: 'Secreto inválido' }, { status: 403 });
  if (account.status !== 'active') return NextResponse.json({ ok: true, paused: true });
  try {
    for (const message of parsed.messages) await recordInboundMessage(account, message);
  } catch (err) {
    console.error('[telegram-webhook] persist failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Error al guardar' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from 'next/server';
import { getChannelAdapter } from '@/modules/comms/adapters';
import {
  applyDeliveryUpdate,
  findAccountForTwilioWebhook,
  recordInboundMessage,
} from '@/modules/comms/comms-service';
import { parseFormBody } from '@/modules/comms/adapters/twilio-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/twilio/messaging[?accountId=...]
 *
 * Inbound messages and status callbacks for every Twilio number/sender.
 * Authentication: X-Twilio-Signature validated by the adapter against the
 * public URL (TWILIO_WEBHOOK_BASE_URL). Idempotent: a repeated MessageSid is
 * acknowledged without creating a second row. Media download is deferred to
 * the `comms.process_inbound` job so Twilio gets its answer immediately.
 */
function twiml(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function headersOf(request: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const params = parseFormBody(rawBody);
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  const account = await findAccountForTwilioWebhook(
    request.nextUrl.searchParams.get('accountId'),
    first(params.To)
  );
  if (!account) return NextResponse.json({ error: 'Cuenta no encontrada' }, { status: 404 });
  if (account.status !== 'active') return twiml();

  const adapter = getChannelAdapter(account.provider);
  let parsed;
  try {
    parsed = await adapter.parseWebhook(account, {
      headers: headersOf(request),
      rawBody,
      url: request.url,
    });
  } catch (err) {
    console.error('[twilio-webhook] parse failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Error al procesar' }, { status: 500 });
  }
  if (!parsed) return NextResponse.json({ error: 'Firma inválida' }, { status: 403 });

  try {
    for (const message of parsed.messages) await recordInboundMessage(account, message);
    for (const update of parsed.deliveries) await applyDeliveryUpdate(account, update);
  } catch (err) {
    console.error('[twilio-webhook] persist failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Error al guardar' }, { status: 500 });
  }
  return twiml();
}

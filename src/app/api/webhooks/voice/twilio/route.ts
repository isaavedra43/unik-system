import { NextRequest, NextResponse } from 'next/server';
import {
  buildInboundTwiml,
  buildRejectTwiml,
  registerInboundCall,
  VoiceError,
} from '@/modules/voice/voice-service';
import {
  buildSignedWebhookUrl,
  formParamsToRecord,
  verifyTwilioSignature,
} from '@/modules/voice/twilio-signature';
import { LiveKitError } from '@/modules/voice/livekit-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/voice/twilio — Twilio Voice "A call comes in".
 *
 * Validates `X-Twilio-Signature` (HMAC-SHA1 over TWILIO_WEBHOOK_BASE_URL +
 * path + sorted POST params with TWILIO_AUTH_TOKEN), registers the inbound
 * VoiceCall and answers with TwiML that dials the LiveKit SIP endpoint so the
 * PSTN leg lands in the call's room.
 */
function xml(body: string, status = 200): NextResponse {
  return new NextResponse(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}

export async function POST(request: NextRequest) {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL?.trim();
  if (!authToken || !baseUrl) {
    return NextResponse.json({ error: 'Webhook de Twilio no configurado' }, { status: 503 });
  }
  const raw = await request.text();
  const params = formParamsToRecord(new URLSearchParams(raw));
  const url = buildSignedWebhookUrl(baseUrl, request.nextUrl.pathname, request.nextUrl.search);
  if (!verifyTwilioSignature(authToken, url, params, request.headers.get('x-twilio-signature'))) {
    return NextResponse.json({ error: 'Firma inválida' }, { status: 403 });
  }
  const from = params.From ?? '';
  const to = params.To ?? '';
  const callSid = params.CallSid ?? '';
  if (!from || !to || !callSid) return xml(buildRejectTwiml('rejected'), 200);

  try {
    const { call, sipUri } = await registerInboundCall({
      fromNumber: from,
      toNumber: to,
      providerCallSid: callSid,
    });
    return xml(buildInboundTwiml(call.id, sipUri));
  } catch (err) {
    if (err instanceof VoiceError || err instanceof LiveKitError) {
      console.error('[voice-twilio-webhook]', err.code, err.message);
    } else {
      console.error('[voice-twilio-webhook]', err instanceof Error ? err.message : 'error');
    }
    // Twilio expects TwiML; a busy signal is safer than an HTML error page.
    return xml(buildRejectTwiml('busy'), 200);
  }
}

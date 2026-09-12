import { NextRequest, NextResponse } from 'next/server';
import { LiveKitError, receiveWebhook } from '@/modules/voice/livekit-service';
import { handleLiveKitEvent, VoiceError } from '@/modules/voice/voice-service';
import '@/modules/jobs/register-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/voice/livekit — LiveKit server webhooks.
 *
 * Real mode: the SDK `WebhookReceiver` verifies the `Authorization` JWT
 * signed with the API secret. Mock mode (no LIVEKIT_URL): the request must
 * carry `X-Livekit-Mock-Secret` equal to `LIVEKIT_MOCK_WEBHOOK_SECRET`.
 * Handles participant_joined/left, room_finished and egress_ended.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  try {
    const event = await receiveWebhook(body, {
      authorization: request.headers.get('authorization'),
      mockSecret: request.headers.get('x-livekit-mock-secret'),
    });
    const result = await handleLiveKitEvent(event);
    return NextResponse.json({ ok: true, event: event.event, ...result });
  } catch (err) {
    if (err instanceof LiveKitError || err instanceof VoiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error('[voice-livekit-webhook]', err instanceof Error ? err.message : 'error');
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { buildAgentContext } from '@/modules/voice/voice-agent-service';
import { agentErrorResponse, callIdFrom, guard } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/internal/voice/agent/context?callId= — brief for a dispatched worker. */
export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const callId = callIdFrom(request);
  if (!callId) return NextResponse.json({ error: 'callId requerido' }, { status: 400 });
  try {
    return NextResponse.json(await buildAgentContext(callId));
  } catch (err) {
    return agentErrorResponse(err);
  }
}

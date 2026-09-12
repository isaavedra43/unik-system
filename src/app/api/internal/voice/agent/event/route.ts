import { NextResponse } from 'next/server';
import { agentEventSchema, recordAgentEvent } from '@/modules/voice/voice-agent-service';
import { agentErrorResponse, guard } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/internal/voice/agent/event — joined / greeted / left / error / hangup. */
export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const input = agentEventSchema.parse(await request.json());
    return NextResponse.json(await recordAgentEvent(input));
  } catch (err) {
    return agentErrorResponse(err);
  }
}

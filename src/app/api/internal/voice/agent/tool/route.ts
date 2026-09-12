import { NextResponse } from 'next/server';
import { agentToolSchema, runAgentTool } from '@/modules/voice/voice-agent-service';
import { agentErrorResponse, guard } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/internal/voice/agent/tool — executes an allow-listed tool through the common executor. */
export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const input = agentToolSchema.parse(await request.json());
    return NextResponse.json(await runAgentTool(input));
  } catch (err) {
    return agentErrorResponse(err);
  }
}

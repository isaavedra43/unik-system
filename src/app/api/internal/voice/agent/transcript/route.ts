import { NextResponse } from 'next/server';
import { agentTranscriptSchema, recordAgentTranscript } from '@/modules/voice/voice-agent-service';
import { agentErrorResponse, guard } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/internal/voice/agent/transcript — caller/AI segments (gated by aiState/generation). */
export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const input = agentTranscriptSchema.parse(await request.json());
    return NextResponse.json(await recordAgentTranscript(input));
  } catch (err) {
    return agentErrorResponse(err);
  }
}

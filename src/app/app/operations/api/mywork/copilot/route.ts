import type { NextRequest } from 'next/server';
import {
  handleSurfaceGet,
  handleSurfacePost,
  myWorkSurfaceSpec,
  requireCopilotUser,
} from '../../_copilot-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET — the "Mi trabajo" copilot thread of the current user (session + `assistant.use`). */
export async function GET(request: NextRequest) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  return handleSurfaceGet(request, auth.user, myWorkSurfaceSpec(auth.user));
}

/** POST { message } | { trigger } — a "Mi trabajo" copilot turn streamed as SSE. */
export async function POST(request: NextRequest) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  return handleSurfacePost(request, auth.user, myWorkSurfaceSpec(auth.user));
}

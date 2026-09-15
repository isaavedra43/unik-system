import type { NextRequest } from 'next/server';
import {
  caseSurfaceSpec,
  checkCaseCopilotAccess,
  handleSurfaceGet,
  handleSurfacePost,
  requireCopilotUser,
} from '../../../_copilot-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** GET — the case (expediente) copilot thread of the current user. */
export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const denied = await checkCaseCopilotAccess(auth.user, id);
  if (denied) return denied;
  return handleSurfaceGet(request, auth.user, caseSurfaceSpec(id));
}

/** POST { message } | { trigger } — a case copilot turn streamed as SSE. */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const denied = await checkCaseCopilotAccess(auth.user, id);
  if (denied) return denied;
  return handleSurfacePost(request, auth.user, caseSurfaceSpec(id));
}

import type { NextRequest } from 'next/server';
import type { AreaKey } from '@/modules/operations/types';
import {
  areaSurfaceSpec,
  checkAreaCopilotAccess,
  handleSurfaceGet,
  handleSurfacePost,
  requireCopilotUser,
} from '../../../_copilot-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Params = { params: Promise<{ key: string }> };

/** GET — the area copilot thread of the current user (`?list=1`, `?thread=`, `?new=1`). */
export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  const { key } = await params;
  const denied = await checkAreaCopilotAccess(auth.user, key);
  if (denied) return denied;
  return handleSurfaceGet(request, auth.user, areaSurfaceSpec(key as AreaKey));
}

/** POST { message } | { trigger } (+ context of the visible table) — a turn streamed as SSE. */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  const { key } = await params;
  const denied = await checkAreaCopilotAccess(auth.user, key);
  if (denied) return denied;
  return handleSurfacePost(request, auth.user, areaSurfaceSpec(key as AreaKey));
}

import type { NextRequest } from 'next/server';
import {
  checkControlTowerAccess,
  controlTowerSurfaceSpec,
  handleSurfaceGet,
  handleSurfacePost,
  requireCopilotUser,
} from '@/app/app/operations/api/_copilot-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** GET — the Control Tower copilot thread of the current user (requires operations.admin). */
export async function GET(request: NextRequest) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  const denied = checkControlTowerAccess(auth.user);
  if (denied) return denied;
  return handleSurfaceGet(request, auth.user, controlTowerSurfaceSpec());
}

/** POST { message } | { trigger } — a Control Tower copilot turn streamed as SSE. */
export async function POST(request: NextRequest) {
  const auth = await requireCopilotUser();
  if ('response' in auth) return auth.response;
  const denied = checkControlTowerAccess(auth.user);
  if (denied) return denied;
  return handleSurfacePost(request, auth.user, controlTowerSurfaceSpec());
}

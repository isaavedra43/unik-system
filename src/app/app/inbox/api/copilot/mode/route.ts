import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../_shared';
import { getPreferences, updatePreferences } from '@/modules/copilot/preferences-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const prefs = await getPreferences(auth.user.id);
  return NextResponse.json({ mode: prefs.inboxCopilotMode });
}

/** PATCH { mode: active | on_demand | paused } — per-user inbox copilot mode. */
export async function PATCH(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const { mode } = z
      .object({ mode: z.enum(['active', 'on_demand', 'paused']) })
      .parse(await readJson(request));
    const prefs = await updatePreferences(auth.user.id, { inboxCopilotMode: mode });
    return NextResponse.json({ mode: prefs.inboxCopilotMode });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

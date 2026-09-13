import { NextResponse } from 'next/server';
import { requireInboxUser } from '../../_shared';
import { getCopilotMode } from '@/modules/copilot/preferences-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — proactivity of the inbox copilot for the current user.
 * It is configured ONLY in "Asistente IA → Preferencias y memoria"
 * (PATCH /app/assistant/api/preferences); there is no per-panel switch.
 */
export async function GET() {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  return NextResponse.json({ mode: await getCopilotMode(auth.user.id, 'inbox') });
}

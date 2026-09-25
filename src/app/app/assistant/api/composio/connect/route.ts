import { NextResponse } from 'next/server';
import { z } from 'zod';
import { readJson, requireAssistantUser } from '../../extensions/_shared';
import { composioErrorResponse } from '../_shared';
import { connectToolkit } from '@/modules/composio/composio-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ toolkit: z.string().min(1).max(60) });

/** POST /app/assistant/api/composio/connect { toolkit } → { redirectUrl } (Composio hosted authorization). */
export async function POST(request: Request) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  try {
    const { toolkit } = Body.parse(await readJson(request));
    const res = await connectToolkit(auth.user, toolkit);
    return NextResponse.json({
      toolkit: res.toolkit,
      redirectUrl: res.redirectUrl,
      connected: res.connected,
    });
  } catch (err) {
    return composioErrorResponse(err);
  }
}

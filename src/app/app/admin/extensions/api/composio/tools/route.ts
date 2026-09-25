import { NextRequest, NextResponse } from 'next/server';
import { requireExtensionsViewer } from '@/app/app/assistant/api/extensions/_shared';
import { composioErrorResponse } from '@/app/app/assistant/api/composio/_shared';
import { listToolkitTools } from '@/modules/composio/composio-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?toolkit=gmail → the toolkit's tools with UNIK's classified effect (for admin review/overrides). */
export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const toolkit = request.nextUrl.searchParams.get('toolkit');
  if (!toolkit) return NextResponse.json({ error: 'toolkit requerido' }, { status: 400 });
  try {
    return NextResponse.json({ tools: await listToolkitTools(toolkit) });
  } catch (err) {
    return composioErrorResponse(err);
  }
}

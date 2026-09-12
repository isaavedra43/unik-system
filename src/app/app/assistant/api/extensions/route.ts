import { NextRequest, NextResponse } from 'next/server';
import {
  requireExtensionsAdmin,
  requireExtensionsViewer,
  extensionErrorResponse,
  readJson,
} from './_shared';
import {
  createExtension,
  createExtensionSchema,
  listExtensions,
} from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — admin/viewer list of extensions (any state). */
export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const kind = request.nextUrl.searchParams.get('kind') ?? undefined;
  const status = request.nextUrl.searchParams.get('status') ?? undefined;
  return NextResponse.json({ extensions: await listExtensions({ kind, status }) });
}

/** POST /app/assistant/api/extensions — create an extension DRAFT (admin). */
export async function POST(request: NextRequest) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  try {
    const body = createExtensionSchema.parse(await readJson(request));
    const extension = await createExtension(auth.user, body);
    return NextResponse.json({ id: extension.id, status: extension.status }, { status: 201 });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

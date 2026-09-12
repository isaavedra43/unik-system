import { NextRequest, NextResponse } from 'next/server';
import {
  requireExtensionsAdmin,
  requireExtensionsViewer,
  extensionErrorResponse,
  readJson,
} from '../_shared';
import {
  createExtensionSchema,
  getExtensionDetail,
  updateExtension,
} from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ extension: await getExtensionDetail(id) });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = createExtensionSchema.partial().parse(await readJson(request));
    const extension = await updateExtension(auth.user, id, body);
    return NextResponse.json({ id: extension.id, status: extension.status });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

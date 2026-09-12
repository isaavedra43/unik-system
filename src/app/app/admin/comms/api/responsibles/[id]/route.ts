import { NextRequest, NextResponse } from 'next/server';
import { requireInboxAdmin, commsErrorResponse, readJson } from '../../../../../inbox/api/_shared';
import {
  deleteResponsible,
  responsibleInputSchema,
  updateResponsible,
} from '@/modules/comms/responsibles-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const patch = responsibleInputSchema.partial().parse(await readJson(request));
    return NextResponse.json({ responsible: await updateResponsible(auth.user, id, patch) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    await deleteResponsible(auth.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

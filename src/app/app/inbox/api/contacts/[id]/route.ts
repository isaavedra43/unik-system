import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../../_shared';
import { contactInputSchema, getContact, updateContact } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ contact: await getContact(auth.user, id) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const patch = contactInputSchema.partial().parse(await readJson(request));
    return NextResponse.json({ contact: await updateContact(auth.user, id, patch) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../_shared';
import { contactInputSchema, createContact, listContacts } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const q = request.nextUrl.searchParams;
    return NextResponse.json(
      await listContacts(auth.user, {
        search: q.get('search') ?? undefined,
        page: q.get('page') ? Number(q.get('page')) : undefined,
        pageSize: q.get('pageSize') ? Number(q.get('pageSize')) : undefined,
      })
    );
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const input = contactInputSchema.parse(await readJson(request));
    return NextResponse.json({ contact: await createContact(auth.user, input) }, { status: 201 });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

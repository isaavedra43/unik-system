import { NextRequest, NextResponse } from 'next/server';
import { requireInboxUser, commsErrorResponse, readJson } from '../_shared';
import { conversationFiltersSchema, listConversations } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /app/inbox/api/conversations?accountId&status&assigned&tags=a,b&search&cursor&limit */
export async function GET(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const q = request.nextUrl.searchParams;
    const filters = conversationFiltersSchema.parse({
      accountId: q.get('accountId') ?? undefined,
      status: q.get('status') ?? undefined,
      assigned: q.get('assigned') ?? undefined,
      assignedToUserId: q.get('assignedToUserId') ?? undefined,
      tags: q.get('tags') ? q.get('tags')!.split(',').filter(Boolean) : undefined,
      search: q.get('search') ?? undefined,
      cursor: q.get('cursor') ?? undefined,
      limit: q.get('limit') ? Number(q.get('limit')) : undefined,
    });
    return NextResponse.json(await listConversations(auth.user, filters));
  } catch (err) {
    return commsErrorResponse(err);
  }
}

/** POST /app/inbox/api/conversations — same listing with a JSON filter body. */
export async function POST(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const filters = conversationFiltersSchema.parse(await readJson(request));
    return NextResponse.json(await listConversations(auth.user, filters));
  } catch (err) {
    return commsErrorResponse(err);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInboxUser, commsErrorResponse, readJson } from '../../../_shared';
import { addNote, listNotes } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    return NextResponse.json({ notes: await listNotes(auth.user, id) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const { body } = z.object({ body: z.string().min(1).max(4000) }).parse(await readJson(request));
    return NextResponse.json({ note: await addNote(auth.user, id, body) }, { status: 201 });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

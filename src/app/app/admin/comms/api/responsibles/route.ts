import { NextRequest, NextResponse } from 'next/server';
import {
  requireInboxAdmin,
  requireInboxUser,
  commsErrorResponse,
  readJson,
} from '../../../../inbox/api/_shared';
import {
  createResponsible,
  listResponsibles,
  responsibleInputSchema,
} from '@/modules/comms/responsibles-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — readable by inbox users so forms can show who handles what. */
export async function GET(request: NextRequest) {
  const auth = await requireInboxUser();
  if ('response' in auth) return auth.response;
  try {
    const includeInactive = request.nextUrl.searchParams.get('all') === '1';
    return NextResponse.json({
      responsibles: await listResponsibles(auth.user, { includeInactive }),
    });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  try {
    const input = responsibleInputSchema.parse(await readJson(request));
    return NextResponse.json(
      { responsible: await createResponsible(auth.user, input) },
      { status: 201 }
    );
  } catch (err) {
    return commsErrorResponse(err);
  }
}

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireInboxAdmin, commsErrorResponse } from '../../../../inbox/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — active users for the responsible directory. */
export async function GET() {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, username: true },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ users });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

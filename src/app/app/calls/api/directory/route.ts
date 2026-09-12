import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireCallsSession, voiceErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/calls/api/directory — pickers for internal calls, transfers and
 * outbound accounts. Users: id + name only. Accounts: Twilio voice-capable
 * accounts of the user's teams (all for super_admin).
 */
export async function GET() {
  const auth = await requireCallsSession();
  if ('response' in auth) return auth.response;
  try {
    const [users, accounts] = await Promise.all([
      prisma.user.findMany({
        where: { isActive: true, id: { not: auth.user.id } },
        select: { id: true, name: true, username: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      prisma.commAccount.findMany({
        where: {
          status: 'active',
          provider: { startsWith: 'twilio' },
          ...(auth.user.isSuperAdmin
            ? {}
            : {
                OR: [
                  { teamKeys: { isEmpty: true } },
                  { teamKeys: { hasSome: auth.user.roleKeys } },
                ],
              }),
        },
        select: { id: true, label: true, identifier: true, provider: true },
        orderBy: { label: 'asc' },
      }),
    ]);
    return NextResponse.json({ users, accounts });
  } catch (err) {
    return voiceErrorResponse(err);
  }
}

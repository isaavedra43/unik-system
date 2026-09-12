import { NextRequest, NextResponse } from 'next/server';
import { requireInboxAdmin, commsErrorResponse, readJson } from '../../../../inbox/api/_shared';
import { createAccount, createAccountSchema, listAllAccounts } from '@/modules/comms/comms-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ accounts: await listAllAccounts(auth.user) });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

/** POST — creates the account (and its encrypted connection). The Telegram secret is returned ONCE. */
export async function POST(request: NextRequest) {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  try {
    const input = createAccountSchema.parse(await readJson(request));
    return NextResponse.json(await createAccount(auth.user, input), { status: 201 });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

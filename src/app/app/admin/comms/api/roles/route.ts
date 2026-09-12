import { NextResponse } from 'next/server';
import { requireInboxAdmin, commsErrorResponse } from '../../../../inbox/api/_shared';
import { listRoles } from '@/modules/roles/roles-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — role keys used as team keys on accounts. */
export async function GET() {
  const auth = await requireInboxAdmin();
  if ('response' in auth) return auth.response;
  try {
    const roles = await listRoles();
    return NextResponse.json({
      roles: roles.filter((r) => r.isActive).map((r) => ({ key: r.key, name: r.name })),
    });
  } catch (err) {
    return commsErrorResponse(err);
  }
}

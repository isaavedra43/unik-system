import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import '@/modules/jobs/register-handlers';

/** Storage admin endpoints require `files.admin` (super_admin bypasses). */
export async function requireFilesAdmin(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'files.admin')) {
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  }
  return { user: session.user };
}

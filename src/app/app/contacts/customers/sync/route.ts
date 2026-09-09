import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  startSyncContacts,
  getActiveContactsSyncRun,
  SyncAlreadyRunningError,
} from '@/modules/integrations/zoho/contacts-sync';

export const runtime = 'nodejs';

export async function POST() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('customers.view')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  try {
    const activeRun = await getActiveContactsSyncRun();
    if (activeRun) {
      return NextResponse.json({ already_running: true, run_id: activeRun.runId }, { status: 409 });
    }

    const result = await startSyncContacts({ mode: 'sync' });
    return NextResponse.json({ result: { run_id: result.runId, already_running: result.alreadyRunning } });
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ already_running: true }, { status: 409 });
    }
    console.error('contacts sync trigger error', error);
    return NextResponse.json({ error: 'No se pudo iniciar la sincronización' }, { status: 500 });
  }
}

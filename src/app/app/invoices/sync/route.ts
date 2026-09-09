import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { startSyncInvoices, getActiveInvoicesSyncRun } from '@/modules/integrations/zoho/invoices-sync';

export const runtime = 'nodejs';

export async function POST() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('invoices.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  try {
    const activeRun = await getActiveInvoicesSyncRun();
    if (activeRun) return NextResponse.json({ already_running: true, run_id: activeRun.runId }, { status: 409 });
    const result = await startSyncInvoices({ mode: 'sync' });
    return NextResponse.json({ result: { run_id: result.runId, already_running: result.alreadyRunning } });
  } catch (error) {
    console.error('invoices sync trigger error', error);
    return NextResponse.json({ error: 'No se pudo iniciar la sincronización' }, { status: 500 });
  }
}

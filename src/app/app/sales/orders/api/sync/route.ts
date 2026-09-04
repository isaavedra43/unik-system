import { NextResponse } from 'next/server';
import { getSyncStatusAction, syncSalesOrdersAction } from '@/app/app/sales/orders/actions-sync';
import { revalidatePath } from 'next/cache';

export const runtime = 'edge';

export async function GET() {
  try {
    const status = await getSyncStatusAction();
    return NextResponse.json(status);
  } catch (error) {
    console.error('sync status error', error);
    return NextResponse.json({ id: null, status: null, completedAt: null, detailsFetched: 0, detailsFailed: 0 }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await syncSalesOrdersAction();
    
    revalidatePath('/app/sales/orders');
    
    return NextResponse.json(result);
  } catch (error) {
    console.error('sync action error', error);
    return NextResponse.json({ error: 'Error al sincronizar' }, { status: 500 });
  }
}

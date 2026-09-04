'use server';

import { SyncFormState, SyncStatusResult, SyncStatus } from './actions-types';
import { syncSalesOrders } from '@/modules/integrations/zoho/sales-orders-sync';
import { prisma } from '@/lib/prisma';

export async function syncSalesOrdersAction(): Promise<SyncFormState> {
  try {
    const result = await syncSalesOrders({ mode: 'scan' });
    
    if (result.detailsFailed > 0) {
      return { error: `Se encontraron ${result.detailsFailed} órdenes que no se pudieron sincronizar`, success: true };
    }
    
    return { error: null, success: true };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'SyncAlreadyRunningError') {
        return { error: 'Ya existe una sincronización en curso', success: false };
      }
      if (error.name === 'BaselineAlreadyCompletedError') {
        return { error: 'La línea base ya se completó', success: false };
      }
    }
    return { error: 'No pudimos iniciar la sincronización', success: false };
  }
}

export async function getSyncStatusAction(): Promise<SyncStatusResult> {
  const syncRun = await prisma.integrationSyncRun.findFirst({
    where: {
      source: 'zoho',
      entityType: 'sales_order',
    },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });

  if (!syncRun) {
    return { id: null, status: null, completedAt: null, detailsFetched: 0, detailsFailed: 0 };
  }

  return {
    id: syncRun.id,
    status: syncRun.status as SyncStatus,
    completedAt: syncRun.completedAt ? syncRun.completedAt.toISOString() : null,
    detailsFetched: syncRun.detailsFetched,
    detailsFailed: syncRun.detailsFailed,
  };
}

import { NextResponse } from 'next/server';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import { listSalesOrders } from '@/modules/integrations/zoho/sales-orders';
import { ZohoApiError } from '@/modules/integrations/zoho/client';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const salesOrders = await listSalesOrders();
    return NextResponse.json(salesOrders);
  } catch (error) {
    if (error instanceof ZohoApiError) {
      return NextResponse.json({ error: 'External service error' }, { status: 502 });
    }

    return NextResponse.json({ error: 'External service error' }, { status: 503 });
  }
}

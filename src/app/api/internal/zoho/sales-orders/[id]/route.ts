import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import { getSalesOrder } from '@/modules/integrations/zoho/sales-orders';
import { ZohoApiError } from '@/modules/integrations/zoho/client';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  if (typeof id !== 'string' || id.length === 0) {
    return NextResponse.json({ error: 'Invalid sales order id' }, { status: 400 });
  }

  try {
    const salesOrder = await getSalesOrder(id);
    return NextResponse.json(salesOrder);
  } catch (error) {
    if (error instanceof ZohoApiError) {
      return NextResponse.json({ error: 'External service error' }, { status: 502 });
    }

    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid sales order id' }, { status: 400 });
    }

    return NextResponse.json({ error: 'External service error' }, { status: 503 });
  }
}

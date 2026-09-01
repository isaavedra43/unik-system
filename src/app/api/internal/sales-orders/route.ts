import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import {
  getSalesOrdersList,
  salesOrderListQuerySchema,
} from '@/modules/sales/sales-orders-service';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const rawQuery = Object.fromEntries(url.searchParams.entries());

  const parsedQuery = salesOrderListQuerySchema.safeParse(rawQuery);
  if (!parsedQuery.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    const result = await getSalesOrdersList(parsedQuery.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

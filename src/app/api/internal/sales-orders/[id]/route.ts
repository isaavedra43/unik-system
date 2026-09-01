import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import { getSalesOrderById } from '@/modules/sales/sales-orders-service';

export const runtime = 'nodejs';

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const resolvedParams = await params;
  const parsedParams = paramsSchema.safeParse(resolvedParams);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    const order = await getSalesOrderById(parsedParams.data.id);
    if (!order) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(order);
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

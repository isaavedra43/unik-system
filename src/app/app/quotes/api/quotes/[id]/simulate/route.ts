import { NextRequest, NextResponse } from 'next/server';
import { simulateScenariosSchema } from '@/modules/quotes/quotes-contract';
import { requireQuotesUser, quoteErrorResponse, readJson } from '../../../_shared';
import { simulateScenarios } from '@/modules/quotes/quotes-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireQuotesUser();
  if ('response' in auth) return auth.response;
  try {
    const { id } = await params;
    const body = simulateScenariosSchema.parse(await readJson(request));
    return NextResponse.json(await simulateScenarios(auth.user, id, body.scenarios));
  } catch (err) {
    return quoteErrorResponse(err);
  }
}

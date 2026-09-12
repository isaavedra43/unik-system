import { NextRequest, NextResponse } from 'next/server';
import { requireExtensionsViewer } from '@/app/app/assistant/api/extensions/_shared';
import { getUsage, type UsageDimension } from '@/modules/extensions/usage-meter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DIMENSIONS: UsageDimension[] = [
  'extension',
  'provider',
  'user',
  'team',
  'storage',
  'job',
  'campaign',
  'calls',
];

export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const p = request.nextUrl.searchParams;
  const dimension = (p.get('dimension') ?? 'extension') as UsageDimension;
  if (!DIMENSIONS.includes(dimension))
    return NextResponse.json({ error: 'Dimensión inválida' }, { status: 400 });
  return NextResponse.json({
    usage: await getUsage(dimension, {
      key: p.get('key') ?? undefined,
      from: p.get('from') ?? undefined,
      to: p.get('to') ?? undefined,
    }),
  });
}

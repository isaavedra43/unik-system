import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  NormalizationAlreadyRunningError,
  normalizePendingProductSnapshots,
} from '@/modules/products/products-normalizer';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('integrations.manage')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(body?.limit ?? 100), 500));

  try {
    const result = await normalizePendingProductSnapshots({ limit });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof NormalizationAlreadyRunningError) {
      return NextResponse.json({ error: 'Normalization already running' }, { status: 409 });
    }
    console.error('internal products normalize error', error);
    return NextResponse.json({ error: 'Normalization failed' }, { status: 500 });
  }
}

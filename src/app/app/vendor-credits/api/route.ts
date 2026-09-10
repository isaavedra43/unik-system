import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getVendorCreditsWorkspace } from '@/modules/vendor-credits/vendor-credits-service';
import { vendorCreditQueryStateSchema } from '@/modules/vendor-credits/vendor-credits-filters';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (
    !session.user.isSuperAdmin &&
    !session.user.permissionKeys.includes('vendor_credits.view')
  ) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const parsed = vendorCreditQueryStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Query inválida' }, { status: 400 });
  }

  try {
    const result = await getVendorCreditsWorkspace(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    console.error('vendor credits api error', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}

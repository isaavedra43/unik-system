import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { requestProposalSchema } from '@/modules/visual-studio/visual-contract';
import { listProposals, requestProposal } from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'projectId requerido' }, { status: 400 });
  try {
    return NextResponse.json({ proposals: await listProposals(session.user, projectId) });
  } catch (err) {
    return storageErrorResponse(err);
  }
}

/** Registra la propuesta y encola la generación en el proveedor. */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = requestProposalSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const result = await requestProposal(session.user, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return storageErrorResponse(err);
  }
}

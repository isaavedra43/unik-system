import { NextRequest, NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { createProjectSchema } from '@/modules/visual-studio/visual-contract';
import { createProject, listProjects } from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  try {
    return NextResponse.json({ projects: await listProjects(session.user) });
  } catch (err) {
    return storageErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    const { id } = await createProject(session.user, parsed.data);
    return NextResponse.json({ id });
  } catch (err) {
    return storageErrorResponse(err);
  }
}

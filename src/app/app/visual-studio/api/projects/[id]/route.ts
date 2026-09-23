import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentSession } from '@/modules/auth/authorization';
import {
  getProject,
  listAssets,
  listProposals,
  listSurfaces,
  updateProject,
} from '@/modules/visual-studio/visual-service';
import { storageErrorResponse } from '@/app/app/files/api/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(4000).nullish(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  contactId: z.string().nullish(),
  quoteId: z.string().nullish(),
  salesOrderId: z.string().nullish(),
});

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  try {
    const [project, assets, surfaces, proposals] = await Promise.all([
      getProject(session.user, id),
      listAssets(session.user, id),
      listSurfaces(session.user, id),
      listProposals(session.user, id),
    ]);
    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        status: project.status,
        notes: project.notes,
        contactId: project.contactId,
        contactName: project.contact?.companyName ?? project.contact?.contactName ?? null,
        quoteId: project.quoteId,
        salesOrderId: project.salesOrderId,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      },
      assets,
      surfaces,
      proposals,
    });
  } catch (err) {
    return storageErrorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  try {
    await updateProject(session.user, id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storageErrorResponse(err);
  }
}

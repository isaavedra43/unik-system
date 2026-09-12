import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireExtensionsAdmin, extensionErrorResponse, readJson } from '../../_shared';
import { approveVersion, transitionExtension } from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  versionId: z.string().min(1),
  notes: z.string().max(2000).optional(),
  enable: z.boolean().optional(),
});

/** POST /app/assistant/api/extensions/[id]/approve — approve a version (and optionally enable the extension). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    const { prisma } = await import('@/lib/prisma');
    const version = await prisma.extensionVersion.findFirst({
      where: { id: body.versionId, extensionId: id },
      select: { id: true },
    });
    if (!version)
      return NextResponse.json(
        { error: 'Versión no encontrada en esta extensión' },
        { status: 404 }
      );
    const approved = await approveVersion(auth.user, body.versionId, body.notes);
    let extensionStatus: string | undefined;
    if (body.enable) {
      const current = await prisma.extension.findUnique({
        where: { id },
        select: { status: true },
      });
      if (current && current.status !== 'enabled') {
        extensionStatus = (await transitionExtension(auth.user, id, 'enabled')).status;
      }
    }
    return NextResponse.json({ version: approved, extensionStatus });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

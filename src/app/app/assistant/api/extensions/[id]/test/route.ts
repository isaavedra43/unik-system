import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireExtensionsAdmin, extensionErrorResponse, readJson } from '../../_shared';
import { testCapability } from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({
  capabilityId: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  fixture: z.string().max(60).optional(),
  /** Writes only run when explicitly confirmed; otherwise the exact target is previewed. */
  confirmWrite: z.boolean().optional(),
});

/** POST /app/assistant/api/extensions/[id]/test — controlled test of one capability. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    const { prisma } = await import('@/lib/prisma');
    const cap = await prisma.extensionCapability.findFirst({
      where: { id: body.capabilityId, extensionId: id },
      select: { id: true },
    });
    if (!cap)
      return NextResponse.json(
        { error: 'Capacidad no encontrada en esta extensión' },
        { status: 404 }
      );
    const result = await testCapability(auth.user, body.capabilityId, {
      args: body.args,
      fixture: body.fixture,
      confirmWrite: body.confirmWrite,
    });
    return NextResponse.json({ result });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

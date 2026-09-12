import { NextRequest, NextResponse } from 'next/server';
import { requireExtensionsViewer } from '@/app/app/assistant/api/extensions/_shared';
import { prisma } from '@/lib/prisma';
import { toProposalDTO } from '@/modules/extensions/proposals-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — proposals across users (admin), e.g. those pending review after an uncertain outcome. */
export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  const status = request.nextUrl.searchParams.get('status') ?? undefined;
  const rows = await prisma.aiProposal.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return NextResponse.json({
    proposals: rows.map((p) => ({ ...toProposalDTO(p), userId: p.userId })),
  });
}

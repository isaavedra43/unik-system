import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireExtensionsAdmin, extensionErrorResponse, readJson } from '../../_shared';
import { transitionExtension } from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ reason: z.string().max(500).optional(), revoke: z.boolean().optional() });

/** POST /app/assistant/api/extensions/[id]/disable — immediate suspension (or revocation). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    const extension = await transitionExtension(
      auth.user,
      id,
      body.revoke ? 'revoked' : 'suspended',
      body.reason
    );
    return NextResponse.json({ id: extension.id, status: extension.status });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import {
  requireExtensionsAdmin,
  extensionErrorResponse,
  readJson,
} from '@/app/app/assistant/api/extensions/_shared';
import { reviewCapability, reviewCapabilitySchema } from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH — UNIK's own classification of a capability (effect, data, limits, approval, enablement). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = reviewCapabilitySchema.parse(await readJson(request));
    const capability = await reviewCapability(auth.user, id, body);
    return NextResponse.json({
      capability: {
        id: capability.id,
        effect: capability.effect,
        reviewStatus: capability.reviewStatus,
        enabled: capability.enabled,
      },
    });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

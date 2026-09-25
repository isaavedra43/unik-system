import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  readJson,
  requireExtensionsAdmin,
  requireExtensionsViewer,
} from '@/app/app/assistant/api/extensions/_shared';
import { composioErrorResponse } from '@/app/app/assistant/api/composio/_shared';
import { isComposioConfigured } from '@/modules/composio/composio-client';
import { listCatalogToolkits } from '@/modules/composio/composio-service';
import { COMPOSIO_EFFECTS } from '@/modules/composio/composio-effects';
import { listPolicies, upsertPolicy } from '@/modules/composio/composio-policy-service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET → { configured, policies, roles, catalog? }. `?search=` filters the full Composio catalog server-side. */
export async function GET(request: NextRequest) {
  const auth = await requireExtensionsViewer();
  if ('response' in auth) return auth.response;
  try {
    const configured = isComposioConfigured();
    const search = request.nextUrl.searchParams.get('search');
    const [policies, roles] = await Promise.all([
      listPolicies(),
      prisma.role.findMany({ select: { key: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    // Full catalog — the extensions grid renders every toolkit Composio offers.
    const catalog = configured ? await listCatalogToolkits(search ?? undefined) : [];
    return NextResponse.json({ configured, policies, roles, catalog });
  } catch (err) {
    return composioErrorResponse(err);
  }
}

const Patch = z.object({
  toolkit: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  allowedRoleKeys: z.array(z.string().max(64)).max(50).optional(),
  effectOverrides: z
    .record(z.enum(COMPOSIO_EFFECTS as unknown as [string, ...string[]]))
    .optional(),
  disabledTools: z.array(z.string().max(120)).max(500).optional(),
});

/** PUT { toolkit, enabled?, allowedRoleKeys?, effectOverrides?, disabledTools? } */
export async function PUT(request: Request) {
  const auth = await requireExtensionsAdmin();
  if ('response' in auth) return auth.response;
  try {
    const { toolkit, ...patch } = Patch.parse(await readJson(request));
    const policy = await upsertPolicy(auth.user, toolkit, patch);
    return NextResponse.json({ policy });
  } catch (err) {
    return composioErrorResponse(err);
  }
}

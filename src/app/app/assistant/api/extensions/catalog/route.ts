import { NextResponse } from 'next/server';
import { requireAssistantUser } from '../_shared';
import { listCatalogForUser } from '@/modules/extensions/extensions-service';
import { listSkillsForUser } from '@/modules/extensions/skills-service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — catalog of approved extensions available to the caller, with their personal connections. */
export async function GET() {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const extensions = await listCatalogForUser(auth.user);
  const connections = await prisma.extensionConnection.findMany({
    where: { ownerUserId: auth.user.id, scopeType: 'personal', revokedAt: null },
    select: {
      id: true,
      extensionId: true,
      name: true,
      status: true,
      authType: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  const skills = await listSkillsForUser(auth.user);
  return NextResponse.json({
    extensions: extensions.map((e) => ({
      ...e,
      personalConnections: connections
        .filter((c) => c.extensionId === e.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          authType: c.authType,
          expiresAt: c.expiresAt?.toISOString() ?? null,
          createdAt: c.createdAt.toISOString(),
        })),
    })),
    skills,
  });
}

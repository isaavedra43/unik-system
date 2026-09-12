import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hasPermission } from '@/modules/auth/authorization';
import { requireAssistantUser, extensionErrorResponse, readJson } from '../../_shared';
import {
  createConnection,
  listConnections,
  toConnectionDTO,
} from '@/modules/extensions/connections-service';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  scopeType: z.enum(['personal', 'team']).default('personal'),
  authType: z.enum(['api_key', 'bearer', 'basic', 'service']),
  name: z.string().min(1).max(120),
  /** Secrets travel ONCE, over HTTPS, and are stored encrypted. Never returned. */
  secret: z.object({
    apiKey: z.string().max(4000).optional(),
    accessToken: z.string().max(8000).optional(),
    username: z.string().max(200).optional(),
    password: z.string().max(4000).optional(),
    clientSecret: z.string().max(4000).optional(),
  }),
  scopes: z.array(z.string().max(100)).max(30).optional(),
  expiresAt: z.string().datetime().optional(),
});

/** GET — the caller's personal connections (+ team ones for admins). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  const admin = hasPermission(auth.user, 'extensions.manage');
  return NextResponse.json({
    connections: await listConnections(id, auth.user, { includeTeam: admin }),
  });
}

/** POST — connect an account. Personal needs `extensions.connect`; team/service need `extensions.manage`. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const { id } = await params;
  try {
    const body = schema.parse(await readJson(request));
    const extension = await prisma.extension.findUnique({
      where: { id },
      select: { id: true, status: true, allowedRoleKeys: true },
    });
    if (!extension) return NextResponse.json({ error: 'Extensión no encontrada' }, { status: 404 });
    const isTeam = body.scopeType === 'team' || body.authType === 'service';
    if (isTeam && !hasPermission(auth.user, 'extensions.manage')) {
      return NextResponse.json(
        { error: 'Solo un administrador puede crear conexiones de equipo' },
        { status: 403 }
      );
    }
    if (!isTeam) {
      if (!hasPermission(auth.user, 'extensions.connect')) {
        return NextResponse.json({ error: 'Sin permiso para conectar cuentas' }, { status: 403 });
      }
      const allowed =
        auth.user.isSuperAdmin ||
        extension.allowedRoleKeys.some((r) => auth.user.roleKeys.includes(r));
      if (!allowed || extension.status !== 'enabled') {
        return NextResponse.json(
          { error: 'La extensión no está disponible para tu equipo' },
          { status: 403 }
        );
      }
    }
    const connection = await createConnection({
      extensionId: id,
      authType: body.authType,
      scopeType: isTeam ? 'team' : 'personal',
      ownerUserId: auth.user.id,
      name: body.name,
      secret: body.secret,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    return NextResponse.json({ connection: toConnectionDTO(connection) }, { status: 201 });
  } catch (err) {
    return extensionErrorResponse(err);
  }
}

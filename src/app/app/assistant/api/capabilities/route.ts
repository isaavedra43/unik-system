import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAssistantUser } from '../extensions/_shared';
import { buildCapabilityCatalog, GROUP_LABELS } from '@/modules/ai/capability-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/capabilities — everything the agent can use for this
 * user, grouped, with its real state (ready / needs connection / down /
 * disabled). The composer's capability picker and the home screen read it.
 */
export async function GET() {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const items = await buildCapabilityCatalog(auth.user);
  const groups = (Object.keys(GROUP_LABELS) as Array<keyof typeof GROUP_LABELS>)
    .map((id) => ({
      id,
      label: GROUP_LABELS[id],
      // The client only needs the tool COUNT: picks travel as ids and the
      // server maps them back to tools.
      items: items
        .filter((i) => i.group === id)
        .map((item) => {
          const { tools, ...rest } = item;
          delete (rest as Partial<typeof item>).directive;
          return { ...rest, toolCount: tools.length };
        }),
    }))
    .filter((g) => g.items.length > 0);
  return NextResponse.json({ groups, generatedAt: new Date().toISOString() });
}

const probeSchema = z.object({ extensionId: z.string().min(1).max(80) });

/** POST — diagnose one MCP server now (connect + ping with the caller's credentials). */
export async function POST(request: NextRequest) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const parsed = probeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  const { prisma } = await import('@/lib/prisma');
  const extension = await prisma.extension.findUnique({
    where: { id: parsed.data.extensionId },
    include: { capabilities: { select: { connectionScope: true }, take: 50 } },
  });
  const allowed =
    extension &&
    extension.status === 'enabled' &&
    (auth.user.isSuperAdmin ||
      extension.allowedRoleKeys.some((r) => auth.user.roleKeys.includes(r)));
  if (!extension || !allowed)
    return NextResponse.json({ error: 'Extensión no encontrada' }, { status: 404 });
  if (extension.kind !== 'mcp')
    return NextResponse.json(
      { error: 'Solo los servidores MCP se diagnostican aquí' },
      { status: 400 }
    );
  const scope = extension.capabilities.some((c) => c.connectionScope === 'personal')
    ? 'personal'
    : extension.capabilities.some((c) => c.connectionScope === 'team')
      ? 'team'
      : 'none';
  const { probeMcpServer } = await import('@/modules/extensions/mcp-client-service');
  const { mcpHealth } = await import('@/modules/extensions/mcp-health');
  const result = await probeMcpServer(extension, auth.user, scope);
  return NextResponse.json({ ...result, health: mcpHealth(extension.id) });
}

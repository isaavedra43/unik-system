import { NextResponse } from 'next/server';
import { requireKnowledgeAdmin, knowledgeError } from '../_auth';
import { listExtensions } from '@/modules/extensions/extensions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — MCP servers, APIs, plugins and skills the assistant can reach (read-only summary; managed in Extensiones). */
export async function GET() {
  const auth = await requireKnowledgeAdmin();
  if ('response' in auth) return auth.response;
  try {
    const rows = await listExtensions();
    return NextResponse.json({
      connections: rows.map((e) => ({
        id: e.id,
        name: e.name,
        namespace: e.namespace,
        kind: e.kind,
        status: e.status,
        description: e.description,
        capabilities: e.counts.capabilities,
        accounts: e.counts.connections,
        executions: e.counts.executions,
        updatedAt: e.updatedAt,
      })),
    });
  } catch (err) {
    return knowledgeError(err);
  }
}

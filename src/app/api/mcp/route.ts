import { NextResponse } from 'next/server';
import { authenticateMcpRequest, createMcpServerForActor, isMcpServerConfigured, McpAuthError } from '@/modules/ai/mcp-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * UNIK MCP endpoint (Streamable HTTP, stateless).
 *   POST /api/mcp   — JSON-RPC (initialize, tools/list, tools/call…)
 *   GET  /api/mcp   — capability check (no SSE stream in stateless mode)
 * Auth: Authorization: Bearer <UNIK_MCP_API_KEY>. See src/modules/ai/mcp-server.ts.
 */
async function handle(request: Request): Promise<Response> {
  try {
    const actor = await authenticateMcpRequest(request);
    const { server, transport } = await createMcpServerForActor(actor);
    try {
      return await transport.handleRequest(request);
    } finally {
      // Stateless: tear down after the response is produced.
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof McpAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="unik-mcp"' } : undefined });
    }
    console.error('[mcp] request failed', error);
    return NextResponse.json({ error: 'Error interno del servidor MCP' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  if (!isMcpServerConfigured()) return NextResponse.json({ error: 'Servidor MCP no configurado (UNIK_MCP_API_KEY)' }, { status: 503 });
  try {
    await authenticateMcpRequest(request);
  } catch (error) {
    if (error instanceof McpAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return NextResponse.json({ name: 'unik-system', transport: 'streamable-http', stateless: true, endpoint: '/api/mcp', methods: ['POST'] });
}

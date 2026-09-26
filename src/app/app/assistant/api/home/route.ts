import { NextRequest, NextResponse } from 'next/server';
import { requireAssistantUser } from '../extensions/_shared';
import { buildHomeSpec, isHomeEmpty } from '@/modules/ai/genui/home';
import { loadHomeData } from '@/modules/ai/genui/home-data';
import { sanitizeGenUiSpec } from '@/modules/ai/genui/validate';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { loadAvailableTools } from '@/modules/ai/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/home?agentId= — the personalized home for the empty
 * thread, as a json-render spec built only from the caller's own records
 * (decisions, stalled work, next steps, routines, frequent requests, recent
 * threads/files, unread events, capabilities to discover). `empty: true`
 * means a brand-new user: the client shows the getting-started ideas.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAssistantUser();
  if ('response' in auth) return auth.response;
  const agentId = request.nextUrl.searchParams.get('agentId');
  const settings = await getAiSettings();
  const tools = await loadAvailableTools(auth.user, settings.enabledTools).catch(() => []);
  const data = await loadHomeData(auth.user, {
    agentId: agentId && agentId !== 'principal' ? agentId.slice(0, 80) : null,
    availableTools: tools.map((t) => t.name),
  });
  const empty = isHomeEmpty(data);
  const { spec } = sanitizeGenUiSpec(buildHomeSpec(data));
  return NextResponse.json({
    empty,
    spec: spec && Object.keys(spec.elements).length > 1 ? spec : null,
    counts: {
      proposals: data.proposals.length,
      stalled: data.stalled.length,
      working: data.working,
    },
    generatedAt: new Date().toISOString(),
  });
}

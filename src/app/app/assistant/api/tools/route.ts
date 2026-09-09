import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getAvailableTools } from '@/modules/ai/tools';
import { getAiSettings } from '@/modules/ai/ai-admin-config-service';
import { zodToJsonSchema } from '@/modules/ai/tools/zod-to-json-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /app/assistant/api/tools
 *
 * Returns the list of AI tools available to the current user, grouped by
 * category, with their descriptions and parameter schemas. Used by the
 * chat UI to show a "tools" button so the user knows what they can ask.
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  if (!hasPermission(session.user, 'assistant.use')) {
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  }

  const settings = await getAiSettings();
  const tools = getAvailableTools(session.user, settings.enabledTools);

  // Group by category
  const categoryLabels: Record<string, string> = {
    sales: 'Ventas',
    inventory: 'Inventario',
    finance: 'Finanzas',
    system: 'Sistema',
    export: 'Exportación',
  };

  const categoryOrder = ['sales', 'inventory', 'finance', 'export', 'system'];

  const grouped: Record<string, Array<{
    name: string;
    description: string;
    category: string;
    parameters: Record<string, unknown>;
  }>> = {};

  for (const tool of tools) {
    const cat = tool.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({
      name: tool.name,
      description: tool.description,
      category: cat,
      parameters: zodToJsonSchema(tool.parameters),
    });
  }

  // Build ordered result
  const categories = categoryOrder
    .filter((c) => grouped[c])
    .map((c) => ({
      id: c,
      label: categoryLabels[c] ?? c,
      tools: grouped[c],
    }));

  // Add any categories not in the predefined order
  for (const cat of Object.keys(grouped)) {
    if (!categoryOrder.includes(cat)) {
      categories.push({
        id: cat,
        label: categoryLabels[cat] ?? cat,
        tools: grouped[cat],
      });
    }
  }

  return NextResponse.json({
    categories,
    totalTools: tools.length,
  });
}

import { prisma } from '@/lib/prisma';
import { getAiSettings } from './ai-admin-config-service';

/**
 * Capability health — the admin-facing answer to "why didn't the agent do X?".
 *
 * Each capability reports every link in its chain (toggle, API key, enabled
 * tool names) and marks the missing one, so a red row already tells the admin
 * what to fix instead of the failure surfacing as a hallucinated answer.
 */

export interface CapabilityHealth {
  id: string;
  label: string;
  ok: boolean;
  checks: Array<{ label: string; ok: boolean }>;
}

export async function getCapabilityHealth(): Promise<CapabilityHealth[]> {
  const s = await getAiSettings();
  const enabled = new Set(s.enabledTools ?? []);
  const hasTavily = Boolean(s.webSearchApiKey || process.env.TAVILY_API_KEY);
  const hasOpenRouter = Boolean(
    process.env.OPENROUTER_API_KEY ||
      (s.providerConfigs as Record<string, { apiKey?: string }> | undefined)?.openrouter?.apiKey
  );
  const hasDaytona = Boolean(process.env.DAYTONA_API_KEY);

  let extensionCount = 0;
  let mediaExtensionCount = 0;
  try {
    const base = { enabled: true, reviewStatus: 'approved', extension: { status: 'enabled' } };
    [extensionCount, mediaExtensionCount] = await Promise.all([
      prisma.extensionCapability.count({ where: base }),
      prisma.extensionCapability.count({
        where: {
          ...base,
          OR: ['image', 'video', 'imagen', 'media', 'flux', 'dall', 'higgsfield', 'kling', 'runway', 'sora'].flatMap((n) => [
            { name: { contains: n, mode: 'insensitive' as const } },
            { description: { contains: n, mode: 'insensitive' as const } },
          ]),
        },
      }),
    ]);
  } catch {
    extensionCount = 0;
    mediaExtensionCount = 0;
  }

  const rows: CapabilityHealth[] = [
    {
      id: 'web_search',
      label: 'Búsqueda en internet (web_search)',
      ok: false,
      checks: [
        { label: 'Toggle "Búsqueda web" activo', ok: s.webSearchEnabled },
        { label: 'API key (Tavily) configurada', ok: hasTavily },
        { label: '"web_search" en tools habilitados', ok: enabled.has('web_search') },
      ],
    },
    {
      id: 'web_fetch',
      label: 'Lectura de páginas (fetch_url / web_crawl)',
      ok: false,
      checks: [
        { label: 'Toggle "Lectura de páginas" activo', ok: s.webFetchEnabled },
        { label: '"fetch_url" en tools habilitados', ok: enabled.has('fetch_url') },
      ],
    },
    {
      id: 'web_research',
      label: 'Investigación web de varias fuentes (web_research)',
      ok: false,
      checks: [
        { label: 'Búsqueda web activa + key', ok: s.webSearchEnabled && hasTavily },
        { label: 'Lectura de páginas activa', ok: s.webFetchEnabled },
        { label: '"web_research" en tools habilitados', ok: enabled.has('web_research') },
      ],
    },
    {
      id: 'browser',
      label: 'Navegador del agente (computadora virtual)',
      ok: false,
      checks: [
        { label: 'Toggle "Computadora virtual" activo', ok: s.venueEnabled },
        { label: 'DAYTONA_API_KEY configurada', ok: hasDaytona },
        { label: '"browser" en tools habilitados', ok: enabled.has('browser') },
      ],
    },
    {
      id: 'jev',
      label: 'Decisiones Jev (routing, memoria, filtros)',
      ok: false,
      checks: [
        { label: 'Toggle "Decisiones Jev" activo', ok: s.jevEnabled },
        { label: 'API key de OpenRouter', ok: hasOpenRouter },
      ],
    },
    {
      id: 'extensions',
      label: 'Extensiones conectadas (MCP, APIs, Composio)',
      ok: extensionCount > 0,
      checks: [
        { label: `${extensionCount} capacidades aprobadas y activas`, ok: extensionCount > 0 },
      ],
    },
    {
      id: 'media',
      label: 'Generación de imagen/video',
      ok: false,
      checks: [
        { label: `Extensión de media aprobada (${mediaExtensionCount} encontradas)`, ok: mediaExtensionCount > 0 },
        { label: '"generateImage"/"generateVideo" en tools habilitados', ok: enabled.has('generateImage') && enabled.has('generateVideo') },
      ],
    },
  ];
  for (const r of rows) r.ok = r.checks.every((c) => c.ok);
  return rows;
}

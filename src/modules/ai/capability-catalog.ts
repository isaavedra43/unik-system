import type { CurrentUser } from '@/modules/auth/authorization';
import { getAiSettings } from './ai-admin-config-service';
import { CAPABILITY_DEFS, type CapabilityId } from './capabilities';
import { loadAvailableTools, type ToolDefinition } from './tools/registry';

/**
 * Capability catalog — everything the user can ask the agent to USE, with the
 * real state for THIS user right now: built-in powers (internet, browser,
 * computer, documents, images, team, routines), MCP servers, imported APIs,
 * plugins, skills and connected apps.
 *
 * `tools` are the exact tool names the agent will be given when the user
 * picks the item (resolved server-side from what the actor can really run —
 * a down server, a missing connection or a disabled toggle never shows as
 * ready). The composer sends item ids; `resolvePickedCapabilities` maps them
 * back to tools on the server, so the client can never inject tool names.
 */

export type CapabilityGroup =
  | 'internet'
  | 'computer'
  | 'create'
  | 'team'
  | 'automation'
  | 'mcp'
  | 'api'
  | 'plugin'
  | 'skills'
  | 'apps';

export type CapabilityState = 'ready' | 'degraded' | 'needs_connection' | 'down' | 'disabled';

export interface CapabilityItem {
  id: string;
  group: CapabilityGroup;
  label: string;
  description: string;
  state: CapabilityState;
  /** Why it is not ready / what to do. */
  stateText?: string;
  /** Tool names the agent gets when the user picks it. */
  tools: string[];
  /** lucide icon hint for the client. */
  icon: string;
  /** Instruction for the model when the user picks it. */
  directive: string;
  /** Extra data for diagnostics (MCP health) and actions. */
  extensionId?: string;
  health?: {
    status: string;
    latencyMs: number | null;
    lastError: string | null;
    retryAt: string | null;
    lastOkAt: string | null;
  };
  connect?: { kind: 'oauth' | 'composio'; target: string };
}

export const GROUP_LABELS: Record<CapabilityGroup, string> = {
  internet: 'Internet',
  computer: 'Computadora virtual',
  create: 'Crear',
  team: 'Equipo',
  automation: 'Rutinas y automatizaciones',
  mcp: 'Servidores MCP',
  api: 'APIs',
  plugin: 'Plugins',
  skills: 'Habilidades',
  apps: 'Apps conectadas',
};

interface BuiltinDef {
  id: string;
  group: CapabilityGroup;
  label: string;
  description: string;
  icon: string;
  cap?: CapabilityId;
  tools?: RegExp;
  directive: string;
}

const BUILTINS: BuiltinDef[] = [
  {
    id: 'builtin:web',
    group: 'internet',
    label: 'Búsqueda en internet',
    description: 'Busca, lee y cruza fuentes con citas.',
    icon: 'globe',
    cap: 'web',
    directive:
      'El usuario pidió usar INTERNET en este mensaje: busca y lee fuentes reales (web_search / web_research / fetch_url) y cítalas.',
  },
  {
    id: 'builtin:browser',
    group: 'computer',
    label: 'Navegador',
    description: 'Entra a sitios, hace clic y llena formularios como una persona.',
    icon: 'mouse-pointer',
    cap: 'browser',
    directive:
      'El usuario pidió usar el NAVEGADOR de la computadora virtual en este mensaje: ábrelo y opera la página real.',
  },
  {
    id: 'builtin:computer',
    group: 'computer',
    label: 'Computadora virtual',
    description: 'Terminal, archivos y código en su propia máquina.',
    icon: 'terminal',
    cap: 'computer',
    directive:
      'El usuario pidió usar la COMPUTADORA VIRTUAL en este mensaje: trabaja con la terminal y los archivos de la venue.',
  },
  {
    id: 'builtin:docs',
    group: 'create',
    label: 'Documentos y reportes',
    description: 'PDF, Excel, Word, CSV y gráficas con datos reales.',
    icon: 'file-text',
    cap: 'docs',
    directive:
      'El usuario pidió un DOCUMENTO o reporte: entrégalo como archivo generado con las tools de documentos.',
  },
  {
    id: 'builtin:ui',
    group: 'create',
    label: 'Tarjetas e interfaces',
    description: 'Tablas, gráficas, calculadoras y tableros dentro del chat.',
    icon: 'layout-dashboard',
    cap: 'ui',
    directive:
      'El usuario pidió verlo como INTERFAZ en el chat: usa renderView / renderInteractiveUi con datos reales.',
  },
  {
    id: 'builtin:media',
    group: 'create',
    label: 'Imágenes y video',
    description: 'Genera o analiza imágenes y video.',
    icon: 'image',
    cap: 'media',
    directive: 'El usuario pidió generar o analizar IMAGEN o VIDEO en este mensaje.',
  },
  {
    id: 'builtin:site',
    group: 'create',
    label: 'Sitio web',
    description: 'Lo construye, lo publica y te da el enlace.',
    icon: 'rocket',
    tools: /^(publishSite|listSites|unpublishSite)$/,
    directive: 'El usuario pidió crear y publicar un SITIO WEB en este mensaje.',
  },
  {
    id: 'builtin:team',
    group: 'team',
    label: 'Trabajo en equipo',
    description: 'Reparte entre especialistas en paralelo, revisa y consolida.',
    icon: 'users',
    tools: /^(delegateTask|listAgents)$/,
    directive:
      'El usuario pidió TRABAJO EN EQUIPO: reparte las partes independientes entre especialistas con delegateTask, en paralelo, y consolida.',
  },
  {
    id: 'builtin:routines',
    group: 'automation',
    label: 'Rutina o misión',
    description: 'Algo que corre solo cada día o hasta cumplir un objetivo.',
    icon: 'repeat',
    cap: 'missions',
    directive:
      'El usuario quiere una RUTINA o MISIÓN: propónla con proposeMission (objetivo, pasos y horario si es recurrente).',
  },
  {
    id: 'builtin:memory',
    group: 'automation',
    label: 'Memoria',
    description: 'Recuerda o consulta lo que ya sabe de ti.',
    icon: 'brain',
    cap: 'memory',
    directive: 'El usuario pidió usar la MEMORIA: consulta o guarda lo relevante.',
  },
];

function matchTools(tools: ToolDefinition[], def: BuiltinDef): string[] {
  const re = def.tools ?? CAPABILITY_DEFS.find((c) => c.id === def.cap)?.tools;
  if (!re) return [];
  return tools.filter((t) => re.test(t.name)).map((t) => t.name);
}

function enableHint(def: BuiltinDef): string | undefined {
  return def.cap ? CAPABILITY_DEFS.find((c) => c.id === def.cap)?.enableHint : undefined;
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]).catch(
    () => fallback
  );
}

export async function buildCapabilityCatalog(actor: CurrentUser): Promise<CapabilityItem[]> {
  const settings = await getAiSettings();
  const { refreshExternalTools } = await import('@/modules/extensions/external-tools');
  await refreshExternalTools().catch(() => undefined);
  const tools = await loadAvailableTools(actor, settings.enabledTools);
  const items: CapabilityItem[] = [];

  for (const def of BUILTINS) {
    const names = matchTools(tools, def);
    items.push({
      id: def.id,
      group: def.group,
      label: def.label,
      description: def.description,
      icon: def.icon,
      directive: def.directive,
      tools: names,
      state: names.length > 0 ? 'ready' : 'disabled',
      stateText:
        names.length > 0 ? undefined : (enableHint(def) ?? 'No está habilitado para tu usuario.'),
    });
  }

  // Extensions (MCP, APIs, plugins): what exists, with health and connection state.
  const [{ listCatalogForUser }, { mcpHealth, describeMcpFailure }, { prisma }] = await Promise.all(
    [
      import('@/modules/extensions/extensions-service'),
      import('@/modules/extensions/mcp-health'),
      import('@/lib/prisma'),
    ]
  );
  const catalog = await listCatalogForUser(actor).catch(() => []);
  const personal = await prisma.extensionConnection
    .findMany({
      where: { ownerUserId: actor.id, scopeType: 'personal', status: 'active', revokedAt: null },
      select: { extensionId: true },
    })
    .catch(() => [] as Array<{ extensionId: string }>);
  const connected = new Set(personal.map((c) => c.extensionId));

  for (const ext of catalog) {
    if (ext.kind === 'skill') continue; // listed with the skills below
    const group: CapabilityGroup =
      ext.kind === 'mcp' ? 'mcp' : ext.kind === 'api' ? 'api' : 'plugin';
    const names = tools.filter((t) => t.extensionId === ext.id).map((t) => t.name);
    const needsPersonal = ext.capabilities.some((c) => c.connectionScope === 'personal');
    const health = ext.kind === 'mcp' ? mcpHealth(ext.id) : null;
    let state: CapabilityState;
    let stateText: string | undefined;
    if (health?.status === 'down') {
      state = 'down';
      stateText = `${describeMcpFailure(health.lastKind)} Se reintenta sola${health.retryAt ? ` a las ${new Date(health.retryAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}` : ''}.`;
    } else if (needsPersonal && !connected.has(ext.id)) {
      state = 'needs_connection';
      stateText = 'Conecta tu cuenta para usarlo.';
    } else if (names.length === 0) {
      state = 'disabled';
      stateText = 'Sin herramientas aprobadas para tu rol.';
    } else {
      state = health?.status === 'degraded' ? 'degraded' : 'ready';
      stateText = state === 'degraded' ? 'Falló una vez hace poco; sigue disponible.' : undefined;
    }
    items.push({
      id: `ext:${ext.id}`,
      group,
      label: ext.name,
      description:
        ext.description ||
        `${ext.capabilities.length} herramienta${ext.capabilities.length === 1 ? '' : 's'}`,
      icon: group === 'mcp' ? 'server' : group === 'api' ? 'plug' : 'puzzle',
      directive: `El usuario pidió usar ${ext.name} en este mensaje: usa sus herramientas (${ext.namespace}__*).`,
      tools: names,
      state,
      stateText,
      extensionId: ext.id,
      health: health
        ? {
            status: health.status,
            latencyMs: health.latencyMs,
            lastError: health.lastError,
            retryAt: health.retryAt,
            lastOkAt: health.lastOkAt,
          }
        : undefined,
      connect:
        state === 'needs_connection' && ext.oauthConfigured
          ? { kind: 'oauth', target: ext.id }
          : undefined,
    });
  }

  // Skills the user may run.
  const runSkill = tools.some((t) => t.name === 'runSkill');
  const { listSkillsForUser } = await import('@/modules/extensions/skills-service');
  const skills = await listSkillsForUser(actor).catch(() => []);
  for (const skill of skills) {
    if (skill.status === 'suspended' || skill.status === 'archived') continue;
    items.push({
      id: `skill:${skill.key}`,
      group: 'skills',
      label: skill.name,
      description: skill.purpose,
      icon: 'sparkles',
      directive: `El usuario pidió usar la habilidad "${skill.name}" (key ${skill.key}): ejecútala con runSkill.`,
      tools: runSkill ? ['runSkill'] : [],
      state: runSkill ? 'ready' : 'disabled',
      stateText: runSkill ? undefined : 'Las habilidades no están habilitadas.',
    });
  }

  // Connected apps (Composio) — never blocks the catalog for long.
  const { isComposioConfigured } = await import('@/modules/composio/composio-client');
  if (isComposioConfigured()) {
    const { listToolkits } = await import('@/modules/composio/composio-service');
    const toolkits = await withTimeout(listToolkits(actor, { limit: 50 }), 2_500, []);
    const exec = tools.filter((t) => /^composio/.test(t.name)).map((t) => t.name);
    for (const tk of toolkits) {
      items.push({
        id: `app:${tk.slug}`,
        group: 'apps',
        label: tk.name,
        description: tk.connected ? 'Conectada' : 'Sin conectar',
        icon: 'app',
        directive: `El usuario pidió usar ${tk.name} (Composio, toolkit "${tk.slug}") en este mensaje.`,
        tools: exec,
        state: tk.connected ? (exec.length > 0 ? 'ready' : 'disabled') : 'needs_connection',
        stateText: tk.connected ? undefined : 'Conéctala para que el agente la use.',
        connect: tk.connected ? undefined : { kind: 'composio', target: tk.slug },
      });
    }
  }
  return items;
}

export interface PickedCapabilities {
  tools: Set<string>;
  directives: string[];
  labels: string[];
}

/**
 * Maps the ids the composer sent to tools this actor can run and to one
 * instruction per pick. Unknown or unavailable ids are dropped.
 */
export async function resolvePickedCapabilities(
  actor: CurrentUser,
  ids: string[],
  availableTools: ReadonlyArray<{ name: string; extensionId?: string }>
): Promise<PickedCapabilities> {
  const out: PickedCapabilities = { tools: new Set(), directives: [], labels: [] };
  const wanted = [...new Set(ids)].slice(0, 12);
  if (wanted.length === 0) return out;
  const names = new Set(availableTools.map((t) => t.name));
  for (const id of wanted) {
    const def = BUILTINS.find((b) => b.id === id);
    if (def) {
      const re = def.tools ?? CAPABILITY_DEFS.find((c) => c.id === def.cap)?.tools;
      const matched = re ? [...names].filter((n) => re.test(n)) : [];
      if (matched.length === 0) continue;
      matched.forEach((n) => out.tools.add(n));
      out.directives.push(def.directive);
      out.labels.push(def.label);
      continue;
    }
    if (id.startsWith('ext:')) {
      const extId = id.slice(4);
      const matched = availableTools.filter((t) => t.extensionId === extId).map((t) => t.name);
      if (matched.length === 0) continue;
      matched.forEach((n) => out.tools.add(n));
      out.directives.push(
        `El usuario pidió usar esta extensión en este mensaje: ${matched.slice(0, 8).join(', ')}.`
      );
      out.labels.push(extId);
      continue;
    }
    if (id.startsWith('skill:') && names.has('runSkill')) {
      const key = id
        .slice(6)
        .replace(/[^A-Za-z0-9_.:-]/g, '')
        .slice(0, 80);
      if (!key) continue;
      out.tools.add('runSkill');
      out.directives.push(`El usuario pidió ejecutar la habilidad con key "${key}" (runSkill).`);
      out.labels.push(key);
      continue;
    }
    if (id.startsWith('app:')) {
      const slug = id
        .slice(4)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 60);
      const exec = [...names].filter((n) => /^composio/.test(n));
      if (!slug || exec.length === 0) continue;
      exec.forEach((n) => out.tools.add(n));
      out.directives.push(
        `El usuario pidió usar la app "${slug}" (Composio): búscale la acción con composioSearchTools y ejecútala con composioExecute.`
      );
      out.labels.push(slug);
    }
  }
  void actor;
  return out;
}

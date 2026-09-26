import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { frequentPrompts, mimeForArtifact, type HomeData } from './home';

/**
 * Loads the personalized home for one user (and the agent they are talking
 * to). Every query is scoped to the caller: their proposals, their runs'
 * tasks, their missions, their agents' triggers, their conversations,
 * artifacts and notifications. Fail-soft per section — a missing table or a
 * slow query drops that section, never the whole home.
 */

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** Capabilities worth discovering: shown only if available and never used. */
const DISCOVERABLE: Array<{
  id: string;
  label: string;
  description: string;
  prompt: string;
  icon: string;
  tools: RegExp;
}> = [
  {
    id: 'web',
    label: 'Investiga en internet',
    description: 'Busca, lee y cruza fuentes con citas.',
    prompt: 'Investiga en internet a mis 3 competidores principales y compáralos en una tabla: ',
    icon: 'globe',
    tools: /^(web_search|web_research)$/,
  },
  {
    id: 'ui',
    label: 'Tableros en el chat',
    description: 'KPIs, gráficas y tablas con filtros, con tus datos.',
    prompt: 'Muéstrame un tablero con las ventas de la semana por sucursal, con filtros y gráfica.',
    icon: 'chart',
    tools: /^renderUi$/,
  },
  {
    id: 'computer',
    label: 'Su propia computadora',
    description: 'Abre sitios, llena formularios y corre código.',
    prompt: 'Abre el navegador de la computadora virtual y revisa que mi sitio web cargue bien: ',
    icon: 'monitor',
    tools: /^(browser|computer|venueExec)$/,
  },
  {
    id: 'routine',
    label: 'Rutinas automáticas',
    description: 'Algo que corre solo cada día y te avisa.',
    prompt: 'Cada mañana a las 8 mándame el resumen de ventas de ayer y lo pendiente de cobrar.',
    icon: 'repeat',
    tools: /^proposeMission$/,
  },
  {
    id: 'team',
    label: 'Trabajo en equipo',
    description: 'Reparte tareas entre especialistas en paralelo.',
    prompt:
      'Reparte entre mi equipo: investiga el mercado de mármol en Monterrey y analiza nuestras ventas allá.',
    icon: 'users',
    tools: /^delegateTask$/,
  },
  {
    id: 'docs',
    label: 'Documentos listos',
    description: 'PDF, Excel o Word con datos reales.',
    prompt: 'Prepárame un PDF con las ventas del mes y las cuentas por cobrar vencidas.',
    icon: 'file',
    tools: /^(generatePdfReport|composeDocument)$/,
  },
];

export async function loadHomeData(
  actor: CurrentUser,
  opts: { agentId?: string | null; availableTools?: string[] } = {}
): Promise<HomeData> {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86_400_000);
  const d30 = new Date(now.getTime() - 30 * 86_400_000);
  const d60 = new Date(now.getTime() - 60 * 86_400_000);

  const agent = opts.agentId
    ? await safe(
        prisma.agent.findFirst({
          where: { id: opts.agentId, ownerUserId: actor.id },
          select: { id: true, name: true, kind: true, purpose: true },
        }),
        null
      )
    : null;
  const specialist = agent && agent.kind !== 'principal' ? agent : null;
  const convScope = specialist
    ? { userId: actor.id, agentId: specialist.id }
    : { userId: actor.id };

  const [
    proposals,
    runs,
    missions,
    agents,
    conversations,
    artifacts,
    notifications,
    userMessages,
    usedTools,
  ] = await Promise.all([
    safe(
      prisma.aiProposal.findMany({
        where: { userId: actor.id, status: 'pending', expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, summary: true, conversationId: true, expiresAt: true },
      }),
      []
    ),
    safe(
      prisma.agentRun.findMany({
        where: { userId: actor.id, startedAt: { gte: d7 } },
        select: { id: true },
        orderBy: { startedAt: 'desc' },
        take: 300,
      }),
      []
    ),
    safe(
      prisma.mission.findMany({
        where: {
          userId: actor.id,
          status: { in: ['awaiting_approval', 'blocked', 'active', 'failed'] },
          ...(specialist ? { agentId: specialist.id } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: 12,
        select: {
          goal: true,
          status: true,
          schedule: true,
          nextRunAt: true,
          conversationId: true,
          updatedAt: true,
        },
      }),
      []
    ),
    safe(
      prisma.agent.findMany({
        where: { ownerUserId: actor.id, ...(specialist ? { id: specialist.id } : {}) },
        select: { id: true },
      }),
      []
    ),
    safe(
      prisma.aiConversation.findMany({
        where: convScope,
        orderBy: { updatedAt: 'desc' },
        take: 6,
        select: { id: true, title: true, updatedAt: true },
      }),
      []
    ),
    safe(
      prisma.aiArtifact.findMany({
        where: {
          conversation: { userId: actor.id },
          type: { in: ['pdf', 'xlsx', 'docx', 'csv', 'image'] },
          createdAt: { gte: d30 },
        },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: { id: true, type: true, meta: true, createdAt: true },
      }),
      []
    ),
    safe(
      prisma.notification.findMany({
        where: { userId: actor.id, readAt: null },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { title: true, body: true, url: true, createdAt: true },
      }),
      []
    ),
    safe(
      prisma.aiMessage.findMany({
        where: {
          role: 'user',
          createdAt: { gte: d30 },
          conversation: convScope,
        },
        orderBy: { createdAt: 'desc' },
        take: 400,
        select: { content: true, createdAt: true },
      }),
      []
    ),
    safe(
      prisma.aiToolCall.findMany({
        where: { createdAt: { gte: d60 }, message: { conversation: { userId: actor.id } } },
        distinct: ['toolName'],
        select: { toolName: true },
        take: 300,
      }),
      []
    ),
  ]);

  const [tasks, triggers, followUpMessages] = await Promise.all([
    runs.length === 0
      ? Promise.resolve([])
      : safe(
          prisma.agentTask.findMany({
            where: {
              parentRunId: { in: runs.map((r) => r.id) },
              status: { in: ['failed', 'blocked', 'running', 'queued', 'pending'] },
              ...(specialist ? { assignedAgentId: specialist.id } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { objective: true, status: true, error: true, capsule: true },
          }),
          []
        ),
    agents.length === 0
      ? Promise.resolve([])
      : safe(
          prisma.trigger.findMany({
            where: { agentId: { in: agents.map((a) => a.id) } },
            orderBy: { nextRunAt: 'asc' },
            take: 8,
            select: { action: true, enabled: true, nextRunAt: true, type: true },
          }),
          []
        ),
    conversations.length === 0
      ? Promise.resolve([])
      : safe(
          prisma.aiMessage.findMany({
            where: {
              conversationId: { in: conversations.slice(0, 3).map((c) => c.id) },
              role: 'assistant',
            },
            orderBy: { createdAt: 'desc' },
            take: 9,
            select: { conversationId: true, meta: true },
          }),
          []
        ),
  ]);

  // Next steps: the follow-ups of the LAST answer of each recent thread.
  const seenConv = new Set<string>();
  const followUps: HomeData['followUps'] = [];
  for (const m of followUpMessages) {
    if (seenConv.has(m.conversationId)) continue;
    seenConv.add(m.conversationId);
    const list = ((m.meta as { followUps?: unknown } | null)?.followUps ?? []) as unknown[];
    const title = conversations.find((c) => c.id === m.conversationId)?.title ?? 'Conversación';
    for (const f of list.slice(0, 2)) {
      if (typeof f === 'string' && f.trim())
        followUps.push({
          conversationId: m.conversationId,
          conversationTitle: title,
          text: f.trim(),
        });
    }
  }

  const stalled: HomeData['stalled'] = [
    ...tasks
      .filter((t) => t.status === 'failed' || t.status === 'blocked')
      .map((t) => ({
        kind: 'task' as const,
        title: t.objective,
        status: t.status,
        conversationId:
          ((t.capsule ?? {}) as { conversationId?: string | null }).conversationId ?? null,
        detail: t.error,
      })),
    ...missions
      .filter((m) => ['awaiting_approval', 'blocked', 'failed'].includes(m.status))
      .map((m) => ({
        kind: 'mission' as const,
        title: m.goal,
        status: m.status,
        conversationId: m.conversationId,
        detail: null,
      })),
  ];

  const routines: HomeData['routines'] = [
    ...missions
      .filter((m) => m.schedule && m.status === 'active')
      .map((m) => ({
        title: m.goal,
        nextRunAt: m.nextRunAt?.toISOString() ?? null,
        paused: false,
      })),
    ...triggers.map((t) => ({
      title:
        ((t.action ?? {}) as { goal?: string }).goal ??
        (t.type === 'time' ? 'Rutina programada' : 'Vigilancia'),
      nextRunAt: t.nextRunAt?.toISOString() ?? null,
      paused: !t.enabled,
    })),
  ].sort((a, b) => (a.nextRunAt ?? '9').localeCompare(b.nextRunAt ?? '9'));

  const used = new Set(usedTools.map((t) => t.toolName));
  const available = new Set(opts.availableTools ?? []);
  const discover = DISCOVERABLE.filter(
    (c) => [...available].some((n) => c.tools.test(n)) && ![...used].some((n) => c.tools.test(n))
  ).map(({ id, label, description, prompt, icon }) => ({ id, label, description, prompt, icon }));

  const firstName = (actor.name ?? '').trim().split(/\s+/)[0] ?? '';
  return {
    firstName,
    agent: {
      name: specialist?.name ?? 'Director',
      kind: specialist ? 'specialist' : 'principal',
      purpose: specialist?.purpose ?? null,
    },
    proposals: proposals.map((p) => ({
      id: p.id,
      summary: p.summary,
      conversationId: p.conversationId,
      expiresAt: p.expiresAt.toISOString(),
    })),
    stalled,
    working: tasks.filter((t) => ['running', 'queued', 'pending'].includes(t.status)).length,
    followUps,
    routines,
    frequent: frequentPrompts(
      userMessages
        .filter((m): m is { content: string; createdAt: Date } => typeof m.content === 'string')
        .map((m) => ({ content: m.content, createdAt: m.createdAt }))
    ),
    recent: conversations.slice(0, 4).map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
      snippet: null,
    })),
    files: artifacts.map((a) => {
      const meta = (a.meta ?? {}) as { title?: string; filename?: string; fileName?: string };
      return {
        artifactId: a.id,
        name: meta.filename ?? meta.fileName ?? meta.title ?? `Documento ${a.type.toUpperCase()}`,
        mimeType: mimeForArtifact(a.type),
        createdAt: a.createdAt.toISOString(),
      };
    }),
    notifications: notifications.map((x) => ({
      title: x.title,
      body: x.body,
      url: x.url,
      createdAt: x.createdAt.toISOString(),
    })),
    discover,
  };
}

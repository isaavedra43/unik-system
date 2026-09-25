import { prisma } from '@/lib/prisma';
import { DEFAULT_TENANT_ID } from './tenancy';

/**
 * Agent service — identidad persistente de los agentes de UNIVERSO.
 *
 * Todo es fail-soft: si las tablas de agentes aún no están migradas en
 * producción, los helpers devuelven null/[] y el sistema sigue funcionando
 * como el asistente único actual. La migración puede aplicarse después sin
 * que el código se rompa antes.
 */

export type AgentKind = 'principal' | 'specialist' | 'transient';
export type AgentStatus = 'active' | 'paused' | 'archived';

export interface AgentRecord {
  id: string;
  tenantId: string;
  ownerUserId: string;
  kind: string;
  name: string;
  purpose: string | null;
  persona: string | null;
  icon: string | null;
  color: string | null;
  currentVersionId: string | null;
  status: string;
  autonomy: string;
  venuePolicy: string;
  modelDefault: string | null;
  toolAllowlist: string[];
  maxSpawnDepth: number;
  sortOrder: number;
}

let agentsAvailable: boolean | null = null;

/** true una vez probado que las tablas de agentes existen en esta DB. */
async function agentsTableReady(): Promise<boolean> {
  if (agentsAvailable === false) return false;
  try {
    await prisma.agent.findFirst({ select: { id: true } });
    agentsAvailable = true;
    return true;
  } catch {
    agentsAvailable = false;
    return false;
  }
}

function toRecord(a: AgentRecord): AgentRecord {
  return a;
}

/**
 * El agente principal del usuario (kind='principal', sortOrder 0 — fijado
 * arriba del sidebar). Se crea lazy en el primer uso; idempotente.
 */
export async function ensurePrincipal(tenantId: string, ownerUserId: string, ownerName?: string): Promise<AgentRecord | null> {
  if (!(await agentsTableReady())) return null;
  try {
    const existing = await prisma.agent.findFirst({
      where: { ownerUserId, kind: 'principal', tenantId },
    });
    if (existing) return toRecord(existing as AgentRecord);
    const created = await prisma.agent.create({
      data: {
        tenantId: tenantId || DEFAULT_TENANT_ID,
        ownerUserId,
        kind: 'principal',
        name: 'UNIK Central',
        purpose: `Agente principal de ${ownerName ?? 'su equipo'}`,
        status: 'active',
        sortOrder: 0,
      },
    });
    await prisma.agentVersion.create({
      data: { agentId: created.id, instructions: '', maxDelegations: 4 },
    }).then(async (v) => {
      await prisma.agent.update({ where: { id: created.id }, data: { currentVersionId: v.id } });
    }).catch(() => null);
    return toRecord(created as AgentRecord);
  } catch (err) {
    console.warn('[agents] ensurePrincipal failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function listAgents(tenantId: string, ownerUserId: string): Promise<AgentRecord[]> {
  if (!(await agentsTableReady())) return [];
  try {
    const agents = await prisma.agent.findMany({
      where: { ownerUserId, tenantId, status: { not: 'archived' } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return agents as AgentRecord[];
  } catch {
    return [];
  }
}

export async function getAgent(id: string, ownerUserId: string): Promise<AgentRecord | null> {
  if (!(await agentsTableReady())) return null;
  try {
    const a = await prisma.agent.findFirst({ where: { id, ownerUserId } });
    return (a as AgentRecord | null) ?? null;
  } catch {
    return null;
  }
}

export interface CreateAgentInput {
  name: string;
  purpose?: string;
  persona?: string;
  icon?: string;
  color?: string;
  autonomy?: string;
  venuePolicy?: string;
  toolAllowlist?: string[];
  sortOrder?: number;
}

/** Persona por defecto derivada del propósito — el especialista nace funcionando. */
function defaultPersona(name: string, purpose?: string | null): string {
  return [
    `Eres «${name}», un agente especialista de UNIVERSO.`,
    purpose ? `Tu función: ${purpose}.` : 'Tu función es la que indique cada tarea delegada.',
    'Trabajas con las herramientas del ERP y del equipo que tengas habilitadas.',
    'Entrega resultados verificables y breves; nunca inventes datos ni afirmes haber ejecutado herramientas que no usaste.',
    'Cuando algo requiera aprobación o exceda tu alcance, dilo en el reporte en vez de improvisar.',
  ].join(' ');
}

export async function createAgent(
  tenantId: string,
  ownerUserId: string,
  input: CreateAgentInput
): Promise<AgentRecord | null> {
  if (!(await agentsTableReady())) return null;
  try {
    const persona = input.persona?.trim() || defaultPersona(input.name.trim(), input.purpose);
    const agent = await prisma.agent.create({
      data: {
        tenantId: tenantId || DEFAULT_TENANT_ID,
        ownerUserId,
        kind: 'specialist',
        name: input.name.trim().slice(0, 60),
        purpose: input.purpose?.trim().slice(0, 200) ?? null,
        persona,
        icon: input.icon ?? null,
        color: input.color ?? null,
        autonomy: input.autonomy ?? 'approval',
        venuePolicy: input.venuePolicy ?? 'shared',
        toolAllowlist: input.toolAllowlist ?? [],
        sortOrder: input.sortOrder ?? 100,
      },
    });
    const v = await prisma.agentVersion.create({
      data: { agentId: agent.id, instructions: input.persona ?? '', maxDelegations: 0 },
    });
    await prisma.agent.update({ where: { id: agent.id }, data: { currentVersionId: v.id } });
    return toRecord(agent as AgentRecord);
  } catch (err) {
    console.warn('[agents] createAgent failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Renombrar/reconfigurar: si cambia la persona o políticas, nueva AgentVersion. */
export async function updateAgent(
  id: string,
  ownerUserId: string,
  patch: Partial<CreateAgentInput> & { status?: AgentStatus; modelDefault?: string }
): Promise<AgentRecord | null> {
  if (!(await agentsTableReady())) return null;
  try {
    const current = await prisma.agent.findFirst({ where: { id, ownerUserId } });
    if (!current) return null;
    const updated = await prisma.agent.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 60) } : {}),
        ...(patch.purpose !== undefined ? { purpose: patch.purpose?.trim().slice(0, 200) ?? null } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.autonomy !== undefined ? { autonomy: patch.autonomy } : {}),
        ...(patch.venuePolicy !== undefined ? { venuePolicy: patch.venuePolicy } : {}),
        ...(patch.modelDefault !== undefined ? { modelDefault: patch.modelDefault } : {}),
        ...(patch.toolAllowlist !== undefined ? { toolAllowlist: patch.toolAllowlist } : {}),
      },
    });
    if (patch.persona !== undefined && patch.persona !== current.persona) {
      const v = await prisma.agentVersion.create({
        data: { agentId: id, instructions: patch.persona ?? '', maxDelegations: current.maxSpawnDepth },
      });
      await prisma.agent.update({ where: { id }, data: { currentVersionId: v.id, persona: patch.persona } });
      const refreshed = await prisma.agent.findUnique({ where: { id } });
      return (refreshed as AgentRecord | null) ?? (updated as AgentRecord);
    }
    return toRecord(updated as AgentRecord);
  } catch (err) {
    console.warn('[agents] updateAgent failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Marca qué agente atiende una conversación (fail-soft antes de la migración). */
export async function assignConversationAgent(
  conversationId: string,
  userId: string,
  agentId: string
): Promise<void> {
  try {
    await prisma.aiConversation.updateMany({
      where: { id: conversationId, userId },
      data: { agentId },
    });
  } catch {
    // pre-migration o conversación ajena
  }
}

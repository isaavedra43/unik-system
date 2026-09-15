import { AREA_LABELS, isAreaKey, type AreaKey } from '@/modules/operations/types';

/**
 * Fixed catalog of the agent identities of the coordinated AI layer (plan 5.1).
 * Pure module (no Prisma): the trigger matrix, templates and UI can import it.
 *
 * - Six area coordinators, one per executing/selling area, each backed by a bot
 *   user `ia_<area>` (underscore so the chat mention regex `@(\w+)` matches).
 * - One administrator (`ia_admin`) that covers Administración and the whole
 *   company (case rooms, stuck cases, digests).
 *
 * These are identities over the ONE existing AI engine (`runAssistant`), not
 * separate models or loops.
 */

export const AGENT_AREA_KEYS = [
  'ventas',
  'compras',
  'inventario',
  'manufactura',
  'logistica',
  'contabilidad',
] as const satisfies readonly AreaKey[];

export type AgentAreaKey = (typeof AGENT_AREA_KEYS)[number];

export const ADMIN_AGENT_KEY = 'admin' as const;

export type AgentKey = `area:${AgentAreaKey}` | typeof ADMIN_AGENT_KEY;

export type AgentKind = 'area' | 'admin';

export interface AgentBotDefinition {
  /** `AgentIdentity.key`. */
  agentKey: AgentKey;
  kind: AgentKind;
  /** `AgentIdentity.areaKey`: the coordinator's area; null for the administrator. */
  areaKey: AgentAreaKey | null;
  /** Area whose work the identity covers (`administracion` for the administrator). */
  coversAreaKey: AreaKey;
  /** Bot `User.username`. */
  username: string;
  /** Bot `User.name` and `AgentIdentity.displayName` on creation. */
  displayName: string;
  /** System role of the bot (`Role.key`). */
  roleKey: string;
  roleName: string;
  /** `User.botKind`. */
  botKind: AgentKind;
}

export const AGENT_ROLE_PREFIX = 'agent_';

function areaDefinition(areaKey: AgentAreaKey): AgentBotDefinition {
  const label = AREA_LABELS[areaKey];
  return {
    agentKey: `area:${areaKey}`,
    kind: 'area',
    areaKey,
    coversAreaKey: areaKey,
    username: `ia_${areaKey}`,
    displayName: `IA de ${label}`,
    roleKey: `${AGENT_ROLE_PREFIX}${areaKey}`,
    roleName: `Agente IA de ${label}`,
    botKind: 'area',
  };
}

export const ADMIN_AGENT_DEFINITION: AgentBotDefinition = {
  agentKey: ADMIN_AGENT_KEY,
  kind: 'admin',
  areaKey: null,
  coversAreaKey: 'administracion',
  username: 'ia_admin',
  displayName: 'IA administradora',
  roleKey: `${AGENT_ROLE_PREFIX}admin`,
  roleName: 'Agente IA administrador',
  botKind: 'admin',
};

/** Every identity, area coordinators first (stable order). */
export const AGENT_BOTS: readonly AgentBotDefinition[] = [
  ...AGENT_AREA_KEYS.map(areaDefinition),
  ADMIN_AGENT_DEFINITION,
];

const BY_KEY = new Map<string, AgentBotDefinition>(AGENT_BOTS.map((def) => [def.agentKey, def]));

export const AGENT_KEYS: readonly AgentKey[] = AGENT_BOTS.map((def) => def.agentKey);

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === 'string' && BY_KEY.has(value);
}

export function isAgentAreaKey(value: unknown): value is AgentAreaKey {
  return typeof value === 'string' && (AGENT_AREA_KEYS as readonly string[]).includes(value);
}

/** Definition of an agent key, or null when the key is unknown. */
export function agentBotFor(agentKey: string | null | undefined): AgentBotDefinition | null {
  return agentKey ? (BY_KEY.get(agentKey) ?? null) : null;
}

/**
 * Agent that covers an area: `area:<key>` for the six coordinators and `admin`
 * for Administración, `'admin'`, or a missing area. Unknown strings → null
 * (fail closed: never guess an identity).
 */
export function agentKeyForArea(areaKey: string | null | undefined): AgentKey | null {
  if (!areaKey || areaKey === ADMIN_AGENT_KEY || areaKey === 'administracion') return ADMIN_AGENT_KEY;
  return isAgentAreaKey(areaKey) ? `area:${areaKey}` : null;
}

/** Area covered by an agent key (`administracion` for the administrator); null when unknown. */
export function coveredAreaOf(agentKey: string | null | undefined): AreaKey | null {
  return agentBotFor(agentKey)?.coversAreaKey ?? null;
}

/** True for the system roles of the bots (`agent_ventas`, `agent_admin`, ...). */
export function isAgentRoleKey(roleKey: string): boolean {
  return AGENT_BOTS.some((def) => def.roleKey === roleKey);
}

/** Display name of an identity for an area key ('IA de Compras'); administrator otherwise. */
export function agentDisplayNameForArea(areaKey: string | null | undefined): string {
  const def = agentBotFor(agentKeyForArea(areaKey));
  return def?.displayName ?? ADMIN_AGENT_DEFINITION.displayName;
}

/** Label of the area an agent covers ('Compras'); null when unknown. */
export function coveredAreaLabel(agentKey: string | null | undefined): string | null {
  const area = coveredAreaOf(agentKey);
  return area && isAreaKey(area) ? AREA_LABELS[area] : null;
}

import { randomBytes } from 'node:crypto';
import type { AgentIdentity } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { toCurrentUser, type CurrentUser } from '@/modules/auth/authorization';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import {
  ADMIN_AGENT_KEY,
  AGENT_BOTS,
  agentBotFor,
  agentKeyForArea,
  isAgentKey,
  type AgentBotDefinition,
  type AgentKey,
} from './identity-catalog';
import { agentPermissionsForDefinition } from './permissions';

export * from './identity-catalog';

/**
 * Agent identities (plan 5.1): bot users, their fixed system roles and the
 * `AgentIdentity` rows. Idempotent and safe when several instances boot at
 * once (inserts use ON CONFLICT DO NOTHING and every step re-reads).
 *
 * - Bots can never log in: `passwordHash` is not a bcrypt hash and the login
 *   rejects `isBot` anyway.
 * - Each bot holds exactly ONE role (`agent_<area>` / `agent_admin`, system role)
 *   whose permissions are synced to the fixed allowlist of permissions.ts.
 *   Any other role (above all `super_admin`) is removed on every run.
 * - Admin-editable fields are never overwritten after creation: bot name and
 *   active flag, identity display name, mode and budgets.
 * - A human account or custom role already using a bot username/role key is
 *   never taken over: the identity is reported as a conflict and skipped.
 */

export const UNUSABLE_PASSWORD_PREFIX = '!agent-bot!';

/** A value that is not a bcrypt hash, so no password ever matches it. */
export function unusablePasswordHash(): string {
  return `${UNUSABLE_PASSWORD_PREFIX}${randomBytes(24).toString('hex')}`;
}

export function isUnusablePasswordHash(hash: string | null | undefined): boolean {
  return typeof hash === 'string' && hash.startsWith(UNUSABLE_PASSWORD_PREFIX);
}

export class AgentIdentityError extends Error {
  constructor(
    public readonly code:
      | 'unknown_agent'
      | 'identity_missing'
      | 'bot_missing'
      | 'bot_inactive'
      | 'not_a_bot'
      | 'role_missing'
      | 'super_admin_forbidden',
    message: string
  ) {
    super(message);
    this.name = 'AgentIdentityError';
  }
}

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'agents-identities', event, ...extra }));

const warn = (event: string, extra: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ component: 'agents-identities', event, ...extra }));

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export interface AgentIdentityConflict {
  agentKey: AgentKey;
  reason: 'username_taken_by_human' | 'role_key_taken' | 'identity_unique_conflict';
}

export interface EnsureAgentIdentitiesSummary {
  identities: Array<{ agentKey: AgentKey; identityId: string; botUserId: string; roleId: string }>;
  botsCreated: AgentKey[];
  identitiesCreated: AgentKey[];
  permissionsAdded: number;
  permissionsRemoved: number;
  /** Roles removed from bots (anything but their own agent role). */
  rolesRemoved: Array<{ agentKey: AgentKey; roleKey: string }>;
  conflicts: AgentIdentityConflict[];
}

async function ensureAgentRole(
  def: AgentBotDefinition,
  summary: EnsureAgentIdentitiesSummary
): Promise<{ id: string } | null> {
  await prisma.role.createMany({
    data: [
      {
        key: def.roleKey,
        name: def.roleName,
        description: `Rol de sistema de ${def.displayName}: permisos fijos, sin inicio de sesión`,
        isSystem: true,
        isActive: true,
      },
    ],
    skipDuplicates: true,
  });
  const role = await prisma.role.findUnique({ where: { key: def.roleKey } });
  if (!role) return null;
  if (!role.isSystem) {
    summary.conflicts.push({ agentKey: def.agentKey, reason: 'role_key_taken' });
    warn('role_key_taken', { agentKey: def.agentKey, roleKey: def.roleKey });
    return null;
  }
  if (!role.isActive) {
    await prisma.role.update({ where: { id: role.id }, data: { isActive: true } });
  }

  const expected = agentPermissionsForDefinition(def);
  const current = await prisma.rolePermission.findMany({
    where: { roleId: role.id },
    select: { permissionKey: true },
  });
  const currentKeys = new Set(current.map((p) => p.permissionKey));
  const missing = expected.filter((key) => !currentKeys.has(key));
  if (missing.length > 0) {
    const res = await prisma.rolePermission.createMany({
      data: missing.map((permissionKey) => ({ roleId: role.id, permissionKey })),
      skipDuplicates: true,
    });
    summary.permissionsAdded += res.count;
  }
  const extra = [...currentKeys].filter((key) => !(expected as string[]).includes(key));
  if (extra.length > 0) {
    const res = await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionKey: { in: extra } },
    });
    summary.permissionsRemoved += res.count;
    warn('role_permissions_trimmed', { agentKey: def.agentKey, removed: extra });
  }
  return { id: role.id };
}

async function ensureBotUser(
  def: AgentBotDefinition,
  summary: EnsureAgentIdentitiesSummary
): Promise<{ id: string } | null> {
  let user = await prisma.user.findUnique({ where: { username: def.username } });
  if (!user) {
    const res = await prisma.user.createMany({
      data: [
        {
          username: def.username,
          name: def.displayName,
          email: null,
          passwordHash: unusablePasswordHash(),
          isActive: true,
          isBot: true,
          botKind: def.botKind,
          mustChangePassword: false,
        },
      ],
      skipDuplicates: true,
    });
    user = await prisma.user.findUnique({ where: { username: def.username } });
    if (res.count > 0 && user?.isBot) {
      summary.botsCreated.push(def.agentKey);
      await recordAuditEvent({
        actorUserId: null,
        action: 'agents.bot_user_created',
        targetType: 'user',
        targetId: user.id,
        metadata: { agentKey: def.agentKey, username: def.username },
      });
    }
  }
  if (!user) return null;
  if (!user.isBot) {
    summary.conflicts.push({ agentKey: def.agentKey, reason: 'username_taken_by_human' });
    warn('username_taken_by_human', { agentKey: def.agentKey, username: def.username });
    return null;
  }
  const fixes: { botKind?: string; passwordHash?: string; mustChangePassword?: boolean } = {};
  if (user.botKind !== def.botKind) fixes.botKind = def.botKind;
  if (!isUnusablePasswordHash(user.passwordHash)) fixes.passwordHash = unusablePasswordHash();
  if (user.mustChangePassword) fixes.mustChangePassword = false;
  if (Object.keys(fixes).length > 0) {
    await prisma.user.update({ where: { id: user.id }, data: fixes });
    if (fixes.passwordHash) warn('bot_password_reset_to_unusable', { agentKey: def.agentKey });
  }
  return { id: user.id };
}

async function ensureBotRoles(
  def: AgentBotDefinition,
  botUserId: string,
  roleId: string,
  summary: EnsureAgentIdentitiesSummary
): Promise<void> {
  await prisma.userRole.createMany({ data: [{ userId: botUserId, roleId }], skipDuplicates: true });
  const others = await prisma.userRole.findMany({
    where: { userId: botUserId, roleId: { not: roleId } },
    include: { role: { select: { key: true } } },
  });
  if (others.length === 0) return;
  await prisma.userRole.deleteMany({ where: { userId: botUserId, roleId: { not: roleId } } });
  for (const row of others) {
    summary.rolesRemoved.push({ agentKey: def.agentKey, roleKey: row.role.key });
  }
  const removedKeys = others.map((row) => row.role.key);
  warn('bot_roles_removed', { agentKey: def.agentKey, removed: removedKeys });
  await recordAuditEvent({
    actorUserId: null,
    action: 'agents.bot_roles_removed',
    targetType: 'user',
    targetId: botUserId,
    metadata: {
      agentKey: def.agentKey,
      removed: removedKeys,
      superAdminRemoved: removedKeys.includes(SUPER_ADMIN_ROLE_KEY),
    },
  });
}

async function ensureIdentityRow(
  def: AgentBotDefinition,
  botUserId: string,
  summary: EnsureAgentIdentitiesSummary
): Promise<AgentIdentity | null> {
  let identity = await prisma.agentIdentity.findUnique({ where: { key: def.agentKey } });
  if (!identity) {
    const res = await prisma.agentIdentity.createMany({
      data: [
        {
          key: def.agentKey,
          kind: def.kind,
          areaKey: def.areaKey,
          displayName: def.displayName,
          botUserId,
          mode: 'active',
        },
      ],
      skipDuplicates: true,
    });
    identity = await prisma.agentIdentity.findUnique({ where: { key: def.agentKey } });
    if (res.count > 0 && identity) {
      summary.identitiesCreated.push(def.agentKey);
      await recordAuditEvent({
        actorUserId: null,
        action: 'agents.identity_created',
        targetType: 'agent_identity',
        targetId: identity.id,
        metadata: { agentKey: def.agentKey, botUserId },
      });
    }
  }
  if (!identity) {
    summary.conflicts.push({ agentKey: def.agentKey, reason: 'identity_unique_conflict' });
    warn('identity_unique_conflict', { agentKey: def.agentKey });
    return null;
  }
  const fixes: { kind?: string; areaKey?: string | null; botUserId?: string } = {};
  if (identity.kind !== def.kind) fixes.kind = def.kind;
  if (identity.areaKey !== def.areaKey) fixes.areaKey = def.areaKey;
  if (identity.botUserId !== botUserId) fixes.botUserId = botUserId;
  if (Object.keys(fixes).length === 0) return identity;
  try {
    return await prisma.agentIdentity.update({ where: { id: identity.id }, data: fixes });
  } catch (err) {
    summary.conflicts.push({ agentKey: def.agentKey, reason: 'identity_unique_conflict' });
    warn('identity_fix_failed', {
      agentKey: def.agentKey,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Creates or repairs the 7 agent identities (6 area coordinators + administrator).
 * Never throws for a single identity conflict (reported in the summary); database
 * errors propagate so the caller can log them.
 */
export async function ensureAgentIdentities(): Promise<EnsureAgentIdentitiesSummary> {
  const summary: EnsureAgentIdentitiesSummary = {
    identities: [],
    botsCreated: [],
    identitiesCreated: [],
    permissionsAdded: 0,
    permissionsRemoved: 0,
    rolesRemoved: [],
    conflicts: [],
  };
  for (const def of AGENT_BOTS) {
    const role = await ensureAgentRole(def, summary);
    if (!role) continue;
    const bot = await ensureBotUser(def, summary);
    if (!bot) continue;
    await ensureBotRoles(def, bot.id, role.id, summary);
    const identity = await ensureIdentityRow(def, bot.id, summary);
    if (!identity) continue;
    summary.identities.push({
      agentKey: def.agentKey,
      identityId: identity.id,
      botUserId: bot.id,
      roleId: role.id,
    });
  }
  log('ensured', {
    identities: summary.identities.length,
    botsCreated: summary.botsCreated,
    identitiesCreated: summary.identitiesCreated,
    permissionsAdded: summary.permissionsAdded,
    permissionsRemoved: summary.permissionsRemoved,
    rolesRemoved: summary.rolesRemoved.length,
    conflicts: summary.conflicts,
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `AgentIdentity` row of a known agent key; null when missing or unknown. */
export async function getAgentIdentity(agentKey: string): Promise<AgentIdentity | null> {
  if (!isAgentKey(agentKey)) return null;
  return prisma.agentIdentity.findUnique({ where: { key: agentKey } });
}

/**
 * Identity that covers an area: the coordinator for the six agent areas and the
 * administrator for `administracion`/`admin`/no area. Unknown areas → null.
 */
export async function getIdentityForArea(areaKey: string | null | undefined): Promise<AgentIdentity | null> {
  const agentKey = agentKeyForArea(areaKey);
  return agentKey ? getAgentIdentity(agentKey) : null;
}

/** Administrator identity (creator of the operations channels). */
export async function getAdminIdentity(): Promise<AgentIdentity | null> {
  return getAgentIdentity(ADMIN_AGENT_KEY);
}

/**
 * The bot of an agent as a `CurrentUser`, for tools and commands run by the agent.
 * Uses the same projection as a session (`toCurrentUser`) and then fails closed:
 * - unknown agent, missing identity/bot, inactive bot or a user that is not a bot → error;
 * - any `super_admin` role on the bot → error (never acts as super admin);
 * - roles and permissions are narrowed to the agent role and its fixed allowlist,
 *   so a permission added by hand to the role never takes effect.
 */
export async function buildBotActor(agentKey: string): Promise<CurrentUser> {
  const def = agentBotFor(agentKey);
  if (!def) throw new AgentIdentityError('unknown_agent', `Agente desconocido: ${agentKey}`);
  const identity = await prisma.agentIdentity.findUnique({ where: { key: def.agentKey } });
  if (!identity) {
    throw new AgentIdentityError('identity_missing', `No existe la identidad del agente ${def.agentKey}`);
  }
  const user = await prisma.user.findUnique({
    where: { id: identity.botUserId },
    include: { roles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user) throw new AgentIdentityError('bot_missing', `No existe el usuario de ${def.displayName}`);
  if (!user.isBot) {
    throw new AgentIdentityError('not_a_bot', `El usuario ligado a ${def.displayName} no es un bot`);
  }
  if (!user.isActive) throw new AgentIdentityError('bot_inactive', `${def.displayName} está desactivada`);

  const projected = toCurrentUser(user);
  const hasSuperAdmin =
    projected.isSuperAdmin || user.roles.some((ur) => ur.role.key === SUPER_ADMIN_ROLE_KEY);
  if (hasSuperAdmin) {
    throw new AgentIdentityError(
      'super_admin_forbidden',
      `${def.displayName} tiene el rol de super administrador; se niega a actuar`
    );
  }
  if (!projected.roleKeys.includes(def.roleKey)) {
    throw new AgentIdentityError('role_missing', `${def.displayName} no tiene su rol de agente activo`);
  }
  const allowed = new Set<string>(agentPermissionsForDefinition(def));
  return {
    ...projected,
    roleKeys: [def.roleKey],
    permissionKeys: projected.permissionKeys.filter((key) => allowed.has(key)),
    isSuperAdmin: false,
    mustChangePassword: false,
    isBot: true,
  };
}

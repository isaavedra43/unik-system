import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return { fake: createOpsFake(), recordAuditEvent: vi.fn(async () => {}) };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: mocks.recordAuditEvent }));

import { isKnownPermission } from '@/modules/auth/permissions';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { seedRole, seedUser } from '@/modules/operations/testing/fixtures';
import {
  AGENT_BOTS,
  AgentIdentityError,
  buildBotActor,
  ensureAgentIdentities,
  getAgentIdentity,
  getIdentityForArea,
  isUnusablePasswordHash,
} from './identities';
import { agentPermissionsFor, areaMemberPermissionKeys } from './permissions';

const fake = mocks.fake;

function reset() {
  for (const model of ['user', 'role', 'userRole', 'rolePermission', 'agentIdentity']) {
    fake.rows(model).length = 0;
  }
  mocks.recordAuditEvent.mockClear();
}

const botUser = (username: string) => fake.rows('user').find((u) => u.username === username)!;
const roleByKey = (key: string) => fake.rows('role').find((r) => r.key === key)!;
const permissionsOf = (roleKey: string) =>
  fake
    .rows('rolePermission')
    .filter((p) => p.roleId === roleByKey(roleKey).id)
    .map((p) => p.permissionKey as string)
    .sort();

describe('ensureAgentIdentities', () => {
  beforeEach(reset);

  it('creates 6 area bots and 1 administrator bot that can never log in', async () => {
    const summary = await ensureAgentIdentities();
    expect(summary.conflicts).toEqual([]);
    expect(summary.identities).toHaveLength(7);
    expect(fake.rows('user').map((u) => u.username).sort()).toEqual([
      'ia_admin',
      'ia_compras',
      'ia_contabilidad',
      'ia_inventario',
      'ia_logistica',
      'ia_manufactura',
      'ia_ventas',
    ]);
    for (const user of fake.rows('user')) {
      expect(user.isBot).toBe(true);
      expect(user.isActive).toBe(true);
      expect(isUnusablePasswordHash(user.passwordHash)).toBe(true);
      expect(user.passwordHash.startsWith('$2')).toBe(false);
    }
    expect(botUser('ia_admin').botKind).toBe('admin');
    expect(botUser('ia_compras').botKind).toBe('area');

    const identities = fake.rows('agentIdentity');
    expect(identities.map((i) => i.key).sort()).toEqual(
      ['admin', 'area:compras', 'area:contabilidad', 'area:inventario', 'area:logistica', 'area:manufactura', 'area:ventas'].sort()
    );
    const compras = identities.find((i) => i.key === 'area:compras')!;
    expect(compras).toMatchObject({ kind: 'area', areaKey: 'compras', displayName: 'IA de Compras', mode: 'active', dailyTokenBudget: 150000 });
    expect(compras.botUserId).toBe(botUser('ia_compras').id);
    expect(identities.find((i) => i.key === 'admin')).toMatchObject({ kind: 'admin', areaKey: null, displayName: 'IA administradora' });

    for (const def of AGENT_BOTS) {
      const role = roleByKey(def.roleKey);
      expect(role.isSystem).toBe(true);
      const roles = fake.rows('userRole').filter((ur) => ur.userId === botUser(def.username).id);
      expect(roles.map((ur) => ur.roleId)).toEqual([role.id]);
    }
  });

  it('is idempotent: a second run creates and changes nothing', async () => {
    await ensureAgentIdentities();
    const counts = () => ['user', 'role', 'userRole', 'rolePermission', 'agentIdentity'].map((m) => fake.rows(m).length);
    const before = counts();
    const hashes = fake.rows('user').map((u) => u.passwordHash);
    mocks.recordAuditEvent.mockClear();

    const summary = await ensureAgentIdentities();
    expect(counts()).toEqual(before);
    expect(fake.rows('user').map((u) => u.passwordHash)).toEqual(hashes);
    expect(summary).toMatchObject({ botsCreated: [], identitiesCreated: [], permissionsAdded: 0, permissionsRemoved: 0, rolesRemoved: [], conflicts: [] });
    expect(summary.identities).toHaveLength(7);
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('grants fixed per-area permissions, all from the registry, never administrative ones', async () => {
    await ensureAgentIdentities();
    expect(permissionsOf('agent_inventario')).toEqual(
      ['chat.use', 'inventory.count', 'inventory.reserve', 'inventory.view', 'operations.view', 'products.view'].sort()
    );
    expect(permissionsOf('agent_logistica')).toEqual(['chat.use', 'logistics.dispatch', 'logistics.view', 'operations.view', 'packages.view'].sort());
    expect(permissionsOf('agent_admin')).toEqual(['chat.use', 'operations.manage', 'operations.view']);
    expect(permissionsOf('agent_ventas')).toContain('sales_orders.view');
    expect(permissionsOf('agent_compras')).toContain('purchase_orders.view');

    const all = fake.rows('rolePermission').map((p) => p.permissionKey as string);
    expect(all.every((key) => isKnownPermission(key))).toBe(true);
    for (const forbidden of ['operations.admin', 'inventory.adjust', 'inventory.manage', 'logistics.zoho_write', 'logistics.manage_fleet', 'users.assign_roles', 'chat.admin', 'assistant.admin']) {
      expect(all).not.toContain(forbidden);
    }
    expect(fake.rows('role').some((r) => r.key === SUPER_ADMIN_ROLE_KEY)).toBe(false);
  });

  it('removes super_admin or any other role and trims extra permissions on the next run', async () => {
    await ensureAgentIdentities();
    const superAdmin = seedRole(fake, SUPER_ADMIN_ROLE_KEY);
    const sales = seedRole(fake, 'vendedores', ['sales_orders.view']);
    const bot = botUser('ia_compras');
    fake.seed('userRole', { userId: bot.id, roleId: superAdmin.id });
    fake.seed('userRole', { userId: bot.id, roleId: sales.id });
    fake.seed('rolePermission', { roleId: roleByKey('agent_compras').id, permissionKey: 'users.view' });

    const summary = await ensureAgentIdentities();
    expect(summary.rolesRemoved.map((r) => r.roleKey).sort()).toEqual([SUPER_ADMIN_ROLE_KEY, 'vendedores']);
    expect(summary.permissionsRemoved).toBe(1);
    expect(fake.rows('userRole').filter((ur) => ur.userId === bot.id).map((ur) => ur.roleId)).toEqual([roleByKey('agent_compras').id]);
    expect(permissionsOf('agent_compras')).not.toContain('users.view');
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agents.bot_roles_removed', metadata: expect.objectContaining({ superAdminRemoved: true }) })
    );
    await expect(buildBotActor('area:compras')).resolves.toMatchObject({ isSuperAdmin: false });
  });

  it('never takes over a human account that already uses a bot username', async () => {
    seedUser(fake, { id: 'human', username: 'ia_ventas', name: 'Iván Ventas' });
    const summary = await ensureAgentIdentities();
    expect(summary.conflicts).toEqual([{ agentKey: 'area:ventas', reason: 'username_taken_by_human' }]);
    const human = fake.rows('user').find((u) => u.id === 'human')!;
    expect(human).toMatchObject({ isBot: false, passwordHash: 'x', name: 'Iván Ventas' });
    expect(fake.rows('userRole').some((ur) => ur.userId === 'human' && ur.roleId === roleByKey('agent_ventas').id)).toBe(false);
    expect(await getAgentIdentity('area:ventas')).toBeNull();
    expect(summary.identities).toHaveLength(6);
  });

  it('keeps the fields an administrator edits (mode, budgets, names, active flag)', async () => {
    await ensureAgentIdentities();
    const identity = fake.rows('agentIdentity').find((i) => i.key === 'area:logistica')!;
    identity.mode = 'paused';
    identity.displayName = 'Coordinadora de rutas';
    identity.dailyTokenBudget = 5000;
    const bot = botUser('ia_logistica');
    bot.name = 'Rutas IA';
    bot.isActive = false;

    await ensureAgentIdentities();
    expect(fake.rows('agentIdentity').find((i) => i.key === 'area:logistica')).toMatchObject({
      mode: 'paused',
      displayName: 'Coordinadora de rutas',
      dailyTokenBudget: 5000,
    });
    expect(botUser('ia_logistica')).toMatchObject({ name: 'Rutas IA', isActive: false });
  });

  it('restores an unusable password if a bot somehow got a real one', async () => {
    await ensureAgentIdentities();
    botUser('ia_admin').passwordHash = '$2b$12$abcdefghijklmnopqrstuv';
    await ensureAgentIdentities();
    expect(isUnusablePasswordHash(botUser('ia_admin').passwordHash)).toBe(true);
  });
});

describe('buildBotActor and lookups', () => {
  beforeEach(reset);

  it('projects the bot as a CurrentUser with exactly its role and permissions', async () => {
    await ensureAgentIdentities();
    const actor = await buildBotActor('area:inventario');
    expect(actor).toMatchObject({ username: 'ia_inventario', roleKeys: ['agent_inventario'], isSuperAdmin: false, mustChangePassword: false, isBot: true });
    expect([...actor.permissionKeys].sort()).toEqual(agentPermissionsFor('area:inventario').sort());
  });

  it('refuses to act when the bot holds super_admin (even before the next seed run)', async () => {
    await ensureAgentIdentities();
    const superAdmin = seedRole(fake, SUPER_ADMIN_ROLE_KEY);
    fake.seed('userRole', { userId: botUser('ia_admin').id, roleId: superAdmin.id });
    await expect(buildBotActor('admin')).rejects.toMatchObject({ code: 'super_admin_forbidden' });
  });

  it('ignores permissions added by hand to the agent role', async () => {
    await ensureAgentIdentities();
    fake.seed('rolePermission', { roleId: roleByKey('agent_inventario').id, permissionKey: 'inventory.adjust' });
    const actor = await buildBotActor('area:inventario');
    expect(actor.permissionKeys).not.toContain('inventory.adjust');
  });

  it('fails closed for unknown keys, missing identities and inactive or non-bot users', async () => {
    await expect(buildBotActor('area:marketing')).rejects.toBeInstanceOf(AgentIdentityError);
    await expect(buildBotActor('admin')).rejects.toMatchObject({ code: 'identity_missing' });
    await ensureAgentIdentities();
    botUser('ia_ventas').isActive = false;
    await expect(buildBotActor('area:ventas')).rejects.toMatchObject({ code: 'bot_inactive' });
    botUser('ia_ventas').isActive = true;
    botUser('ia_ventas').isBot = false;
    await expect(buildBotActor('area:ventas')).rejects.toMatchObject({ code: 'not_a_bot' });
  });

  it('resolves the identity of each area (administración → administrator)', async () => {
    await ensureAgentIdentities();
    expect((await getIdentityForArea('compras'))?.key).toBe('area:compras');
    expect((await getIdentityForArea('administracion'))?.key).toBe('admin');
    expect((await getIdentityForArea(null))?.key).toBe('admin');
    expect(await getIdentityForArea('marketing')).toBeNull();
  });
});

describe('agent permission catalog', () => {
  it('takes the keys of installed modules and filters the ones that do not exist', () => {
    const compras = agentPermissionsFor('area:compras');
    expect(compras).toEqual(
      expect.arrayContaining(['chat.use', 'operations.view', 'purchase_orders.view', 'vendors.view', 'purchases.view', 'purchases.request'])
    );
    // Never approvals, receipts, supplier master data or exports.
    for (const forbidden of ['purchases.approve', 'purchases.receive', 'purchases.manage_suppliers', 'purchases.export']) {
      expect(compras).not.toContain(forbidden);
    }
    expect(agentPermissionsFor('area:contabilidad')).toEqual(
      expect.arrayContaining(['finance.view', 'finance.capture_expense', 'finance.manage_obligations'])
    );
    expect(agentPermissionsFor('area:contabilidad')).not.toContain('finance.approve');
    expect(agentPermissionsFor('area:ventas')).not.toContain('crm.create_sales_order');
    expect(agentPermissionsFor('area:unknown')).toEqual([]);
  });

  it('maps area channel membership to module permissions', () => {
    expect(areaMemberPermissionKeys('inventario')).toEqual(
      ['inventory.adjust', 'inventory.count', 'inventory.manage', 'inventory.reserve', 'inventory.view']
    );
    expect(areaMemberPermissionKeys('ventas')).toEqual([
      'crm.create_sales_order',
      'crm.export',
      'crm.manage',
      'crm.manage_stages',
      'crm.radar',
      'crm.view',
      'sales_orders.view',
    ]);
    expect(areaMemberPermissionKeys('administracion')).toEqual(['operations.admin']);
    expect(areaMemberPermissionKeys('compras', ['purchases.view', 'purchases.approve', 'inventory.view'])).toEqual([
      'purchases.approve',
      'purchases.view',
    ]);
  });
});

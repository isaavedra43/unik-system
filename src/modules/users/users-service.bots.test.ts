import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    hashPassword: vi.fn(async (plain: string) => `hash:${plain}`),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/lib/prisma-retry', () => ({
  runSerializableWithRetry: async (
    client: { $transaction: (fn: (tx: unknown) => unknown) => unknown },
    fn: (tx: unknown) => unknown
  ) => client.$transaction(fn),
}));
vi.mock('@/modules/auth/password', () => ({
  generateTemporaryPassword: () => 'Temporal-12345',
  hashPassword: mocks.hashPassword,
}));
vi.mock('@/modules/auth/session-service', () => ({ revokeAllUserSessions: vi.fn(async () => {}) }));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: vi.fn(async () => {}) }));

import { seedUser } from '@/modules/operations/testing/fixtures';
import {
  UserManagementError,
  assignRoles,
  listUsers,
  resetUserPassword,
} from './users-service';

const { fake } = mocks;
type SessionUser = ReturnType<typeof seedUser>['currentUser'];
let root: SessionUser;

beforeEach(() => {
  fake.tables.clear();
  mocks.hashPassword.mockClear();
  root = seedUser(fake, { id: 'root', username: 'root', superAdmin: true }).currentUser;
  seedUser(fake, { id: 'ana', username: 'ana' });
  const bot = seedUser(fake, { id: 'bot_compras', username: 'ia_compras', isBot: true }).user;
  bot.botKind = 'area';
  bot.passwordHash = 'unusable';
  fake.seed('role', { id: 'role_agent_compras', key: 'agent_compras', name: 'Agente de Compras', isSystem: true });
});

describe('user administration with AI (bot) users', () => {
  it('lists bots with their marker', async () => {
    const users = await listUsers();
    expect(users.find((u) => u.id === 'bot_compras')).toMatchObject({ isBot: true, botKind: 'area' });
    expect(users.find((u) => u.id === 'ana')).toMatchObject({ isBot: false, botKind: null });
  });

  it('never resets the password of a bot', async () => {
    await expect(resetUserPassword(root, 'bot_compras')).rejects.toThrow(
      'Los usuarios de IA no tienen contraseña ni pueden iniciar sesión'
    );
    expect(fake.rows('user').find((u) => u.id === 'bot_compras')?.passwordHash).toBe('unusable');
    expect(mocks.hashPassword).not.toHaveBeenCalled();

    await expect(resetUserPassword(root, 'ana')).resolves.toEqual({ temporaryPassword: 'Temporal-12345' });
  });

  it('never grants super_admin to a bot, even for a super admin actor', async () => {
    const superAdminRole = fake.rows('role').find((r) => r.key === 'super_admin')!;

    const attempt = assignRoles(root, 'bot_compras', [superAdminRole.id, 'role_agent_compras']);
    await expect(attempt).rejects.toBeInstanceOf(UserManagementError);
    await expect(
      assignRoles(root, 'bot_compras', [superAdminRole.id])
    ).rejects.toThrow('Un usuario de IA no puede tener el rol super_admin');
    expect(fake.rows('userRole').filter((ur) => ur.userId === 'bot_compras')).toHaveLength(0);

    await assignRoles(root, 'bot_compras', ['role_agent_compras']);
    expect(fake.rows('userRole').filter((ur) => ur.userId === 'bot_compras').map((ur) => ur.roleId)).toEqual([
      'role_agent_compras',
    ]);
  });

  it('never gives an agent_* role to a person nor a non-agent role to a bot', async () => {
    await expect(assignRoles(root, 'ana', ['role_agent_compras'])).rejects.toThrow(
      'Los roles de agente de IA (agent_*) sólo se asignan a usuarios de IA'
    );
    expect(fake.rows('userRole').some((ur) => ur.userId === 'ana' && ur.roleId === 'role_agent_compras')).toBe(false);
    fake.seed('role', { id: 'role_staff', key: 'staff', name: 'Staff' });
    await expect(assignRoles(root, 'bot_compras', ['role_agent_compras', 'role_staff'])).rejects.toThrow(
      'Un usuario de IA sólo puede tener roles de agente (agent_*)'
    );
    await assignRoles(root, 'ana', ['role_staff']);
    expect(fake.rows('userRole').filter((ur) => ur.userId === 'ana').map((ur) => ur.roleId)).toEqual(['role_staff']);
  });
});

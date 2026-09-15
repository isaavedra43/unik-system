import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    verifyPassword: vi.fn(async (plain: string, hash: string) => hash === `hash:${plain}`),
    hashPassword: vi.fn(async (plain: string) => `hash:${plain}`),
    createSession: vi.fn(async (userId: string) => ({
      token: `token_${userId}`,
      sessionId: `session_${userId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/password', () => ({
  verifyPassword: mocks.verifyPassword,
  hashPassword: mocks.hashPassword,
}));
vi.mock('@/modules/auth/session-service', () => ({
  createSession: mocks.createSession,
  revokeAllUserSessions: vi.fn(async () => {}),
  revokeSessionByToken: vi.fn(async () => {}),
}));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: vi.fn(async () => {}) }));

import { seedUser } from '@/modules/operations/testing/fixtures';
import { GENERIC_LOGIN_ERROR, changeOwnPassword, login } from './auth-service';

const { fake } = mocks;
const PASSWORD = 'correcta-y-segura';

beforeEach(() => {
  fake.tables.clear();
  mocks.verifyPassword.mockClear();
  mocks.createSession.mockClear();
  seedUser(fake, { id: 'ana', username: 'ana', email: 'ana@unik.mx' }).user.passwordHash = `hash:${PASSWORD}`;
  // Even a bot row whose hash would match must never get a session.
  seedUser(fake, {
    id: 'bot_compras',
    username: 'ia_compras',
    email: 'ia.compras@unik.mx',
    isBot: true,
  }).user.passwordHash = `hash:${PASSWORD}`;
});

describe('login with AI (bot) users', () => {
  it('rejects bots by username or email with the generic error and no session', async () => {
    await expect(login('ia_compras', PASSWORD)).resolves.toEqual({
      ok: false,
      error: GENERIC_LOGIN_ERROR,
    });
    await expect(login('IA.Compras@unik.mx', PASSWORD)).resolves.toEqual({
      ok: false,
      error: GENERIC_LOGIN_ERROR,
    });

    expect(mocks.createSession).not.toHaveBeenCalled();
    // The bot hash is never compared (constant-time dummy instead) and nothing is recorded.
    expect(mocks.verifyPassword).not.toHaveBeenCalledWith(PASSWORD, `hash:${PASSWORD}`);
    const bot = fake.rows('user').find((u) => u.id === 'bot_compras')!;
    expect(bot.failedLoginAttempts).toBe(0);
    expect(bot.lastLoginAt).toBeUndefined();
  });

  it('still signs people in', async () => {
    const result = await login('ana', PASSWORD);
    expect(result).toMatchObject({ ok: true, token: 'token_ana' });
    expect(mocks.createSession).toHaveBeenCalledWith('ana');
  });

  it('does not let a bot change a password', async () => {
    await expect(changeOwnPassword('bot_compras', 'session', PASSWORD, 'otra-clave-segura')).resolves.toEqual({
      ok: false,
      error: 'Sesión inválida',
    });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });
});

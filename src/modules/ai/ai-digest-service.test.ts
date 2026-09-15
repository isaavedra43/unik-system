import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake({ uniques: { aiUserDigest: [['userId', 'date']] } }),
    chatCompletion: vi.fn(async () => ({ content: 'Día tranquilo.' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('./ai-client', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('./model-policy', () => ({ modelForTask: () => 'utility-model' }));
vi.mock('./ai-admin-config-service', () => ({ getAiSettings: async () => ({ isEnabled: true }) }));

import { seedUser } from '@/modules/operations/testing/fixtures';
import { refreshAllDigests } from './ai-digest-service';

const { fake } = mocks;

beforeEach(() => {
  fake.tables.clear();
  mocks.chatCompletion.mockClear();
  seedUser(fake, { id: 'ana', name: 'Ana' });
  seedUser(fake, { id: 'old', name: 'Inactivo', isActive: false });
  seedUser(fake, { id: 'bot_compras', name: 'IA de Compras', isBot: true });
  seedUser(fake, { id: 'bot_admin', name: 'IA Administradora', isBot: true });
});

describe('refreshAllDigests', () => {
  it('computes digests for active people only, never for AI bot users', async () => {
    await expect(refreshAllDigests()).resolves.toEqual({ users: 1, days: 2 });

    const digests = fake.rows('aiUserDigest');
    expect(digests).toHaveLength(2);
    expect(new Set(digests.map((d) => d.userId))).toEqual(new Set(['ana']));
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });
});

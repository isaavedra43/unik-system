import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Disk hygiene must free Daytona's quota WITHOUT touching live sessions,
 * other environments' sandboxes or sandboxes still being created.
 */

const rows: Array<{
  id: string;
  userId: string;
  status: string;
  externalId: string;
  endedAt: Date | null;
}> = [];
const updates: Array<{ id: string; status: string }> = [];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    venueSession: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
          updates.push({ id: where.id, status: data.status });
          return {};
        }
      ),
    },
  },
}));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn() }));
vi.mock('@/modules/extensions/usage-meter', () => ({ recordUsage: vi.fn() }));
vi.mock('@/modules/realtime/realtime-service', () => ({ publishRealtime: vi.fn() }));
vi.mock('@/modules/extensions/secrets', () => ({
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
  isSecretsConfigured: vi.fn(),
  maskSecret: vi.fn(),
}));

const disposed: Array<{ id: string; mode: string }> = [];
let own: Array<{
  id: string;
  state: string;
  sessionId: string;
  env: string | null;
  touchedAt: number;
}> = [];

vi.mock('./daytona-venue', () => ({
  VENUE_ENV_LABEL: 'unik-env',
  venueEnvName: () => 'production',
  DaytonaVenue: {
    listOwn: vi.fn(async () => own),
    dispose: vi.fn(async (_cfg: unknown, id: string, mode: string) => {
      disposed.push({ id, mode });
      return true;
    }),
  },
}));

import { isQuotaError, reclaimVenueDisk } from './venue-manager';

const cfg = { apiKey: 'k' };
const HOUR = 3_600_000;

describe('venue disk hygiene', () => {
  beforeEach(() => {
    rows.length = 0;
    updates.length = 0;
    disposed.length = 0;
    own = [];
  });

  it('recognizes the Daytona quota error', () => {
    expect(isQuotaError(new Error('Total disk limit exceeded. Maximum allowed: 30GiB.'))).toBe(
      true
    );
    expect(isQuotaError(new Error('network timeout'))).toBe(false);
  });

  it('archives the reusable sandbox, deletes the rest, never touches live or foreign ones', async () => {
    const now = Date.now();
    own = [
      { id: 'live', state: 'started', sessionId: 's-live', env: 'production', touchedAt: now },
      { id: 'u1-new', state: 'stopped', sessionId: 's1', env: 'production', touchedAt: now - HOUR },
      {
        id: 'u1-old',
        state: 'stopped',
        sessionId: 's0',
        env: 'production',
        touchedAt: now - 5 * HOUR,
      },
      { id: 'orphan-old', state: 'stopped', sessionId: 'x', env: null, touchedAt: now - 10 * HOUR },
      {
        id: 'orphan-fresh',
        state: 'started',
        sessionId: 'y',
        env: 'production',
        touchedAt: now - 60_000,
      },
      {
        id: 'staging',
        state: 'stopped',
        sessionId: 'z',
        env: 'staging',
        touchedAt: now - 10 * HOUR,
      },
      {
        id: 'already',
        state: 'archived',
        sessionId: 'w',
        env: 'production',
        touchedAt: now - 10 * HOUR,
      },
    ];
    rows.push(
      { id: 's-live', userId: 'u2', status: 'active', externalId: 'live', endedAt: null },
      {
        id: 's1',
        userId: 'u1',
        status: 'stopped',
        externalId: 'u1-new',
        endedAt: new Date(now - HOUR),
      },
      {
        id: 's0',
        userId: 'u1',
        status: 'stopped',
        externalId: 'u1-old',
        endedAt: new Date(now - 5 * HOUR),
      }
    );

    const res = await reclaimVenueDisk({ cfg });

    expect(disposed).toEqual(
      expect.arrayContaining([
        { id: 'u1-new', mode: 'archive' },
        { id: 'u1-old', mode: 'delete' },
        { id: 'orphan-old', mode: 'delete' },
      ])
    );
    const touched = disposed.map((d) => d.id);
    expect(touched).not.toContain('live');
    expect(touched).not.toContain('orphan-fresh');
    expect(touched).not.toContain('staging');
    expect(touched).not.toContain('already');
    expect(res).toEqual({ archived: 1, deleted: 2 });
    expect(updates).toContainEqual({ id: 's0', status: 'deleted' });
  });

  it('under quota pressure also clears orphans older than 30 minutes', async () => {
    const now = Date.now();
    own = [
      {
        id: 'orphan',
        state: 'started',
        sessionId: 'q',
        env: 'production',
        touchedAt: now - 45 * 60_000,
      },
    ];
    const soft = await reclaimVenueDisk({ cfg });
    expect(soft.deleted).toBe(0);
    const hard = await reclaimVenueDisk({ cfg, aggressive: true });
    expect(hard.deleted).toBe(1);
  });
});

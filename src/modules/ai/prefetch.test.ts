import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from './tools/registry';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Prefetch tests — Jev picks the canonical read; the prefetch warms the shared
 * read cache via the normal executeTool path. Prisma and the network are
 * stubbed; `decide` is controlled per test.
 */

const jev = vi.hoisted(() => ({
  read: 'none' as string | null,
  period: 'none' as string | null,
  executed: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('./decisions/decision-engine', () => ({
  decide: vi.fn(async () =>
    jev.read === null
      ? null
      : {
          answers: {
            read: { type: 'choice', choice: jev.read, confidence: 0.95 },
            period: { type: 'choice', choice: jev.period ?? 'none', confidence: 0.9 },
          },
        }
  ),
  answerChoice: vi.fn((result: { answers: Record<string, { type: string; choice: string }> } | null, key: string) =>
    result?.answers[key]?.type === 'choice' ? result.answers[key].choice : null
  ),
}));
vi.mock('./tools/registry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./tools/registry')>();
  return {
    ...mod,
    executeTool: vi.fn(async (name: string, _actor: unknown, args: unknown) => {
      jev.executed.push({ name, args });
      return { success: true, result: { ok: true }, durationMs: 5 };
    }),
  };
});

import { prefetchLikelyRead } from './prefetch';

const actor = { id: 'u1', permissionKeys: [], isSuperAdmin: true } as unknown as CurrentUser;

const salesTool = {
  name: 'querySalesOrders',
  category: 'sales',
  effect: 'read',
  source: 'builtin',
  parameters: {},
} as unknown as ToolDefinition;
const writeTool = {
  name: 'sendInternalChatMessage',
  category: 'chat',
  effect: 'internal_send',
  source: 'builtin',
  parameters: {},
} as unknown as ToolDefinition;
const summaryTool = {
  name: 'getDashboardSummary',
  category: 'sales',
  effect: 'read',
  source: 'builtin',
  parameters: {},
} as unknown as ToolDefinition;

describe('prefetchLikelyRead', () => {
  beforeEach(() => {
    jev.read = 'none';
    jev.period = 'none';
    jev.executed = [];
  });

  it('warms querySalesOrders with the period Jev detected', async () => {
    jev.read = 'sales_period';
    jev.period = 'yesterday';
    const r = await prefetchLikelyRead('ventas de ayer', actor, [salesTool], {});
    expect(r).toEqual({ tool: 'querySalesOrders', warmed: true, cached: false });
    expect(jev.executed).toEqual([{ name: 'querySalesOrders', args: { dateRange: 'yesterday' } }]);
  });

  it('defaults sales period to today when no period was detected', async () => {
    jev.read = 'sales_period';
    const r = await prefetchLikelyRead('cuánto vendí', actor, [salesTool], {});
    expect(jev.executed[0]?.args).toEqual({ dateRange: 'today' });
    expect(r?.warmed).toBe(true);
  });

  it('does nothing when Jev says none or the tool is not offered', async () => {
    jev.read = 'none';
    expect(await prefetchLikelyRead('hola', actor, [salesTool], {})).toBeNull();
    jev.read = 'sales_period';
    // the predicted tool isn't in this turn's offered set → no prefetch
    expect(await prefetchLikelyRead('ventas', actor, [summaryTool], {})).toBeNull();
    expect(jev.executed).toEqual([]);
  });

  it('never prefetches side-effecting tools even if Jev picked a matching domain', async () => {
    jev.read = 'business_summary';
    const r = await prefetchLikelyRead('cómo va el negocio', actor, [writeTool, summaryTool], {});
    expect(r?.tool).toBe('getDashboardSummary');
    expect(jev.executed.every((c) => c.name !== 'sendInternalChatMessage')).toBe(true);
  });

  it('returns null when Jev is unavailable (decide rejects)', async () => {
    const { decide } = await import('./decisions/decision-engine');
    (decide as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'));
    expect(await prefetchLikelyRead('ventas de hoy', actor, [salesTool], {})).toBeNull();
    expect(jev.executed).toEqual([]);
  });
});

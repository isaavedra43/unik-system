import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';
import { ToolResultCache, cacheKeyFor, isCacheableTool, ttlForArgs } from './tool-cache';

const actor = (id: string, perms: string[]): CurrentUser => ({
  id,
  username: id,
  name: id,
  email: null,
  mustChangePassword: false,
  roleKeys: ['sales'],
  permissionKeys: perms as CurrentUser['permissionKeys'],
  isSuperAdmin: false,
});

describe('ToolResultCache', () => {
  it('stores, expires and evicts (LRU)', () => {
    const cache = new ToolResultCache(2);
    cache.set('a', { v: 1 }, 1000, 0);
    cache.set('b', { v: 2 }, 1000, 0);
    expect(cache.get('a', 10)?.value).toEqual({ v: 1 });
    cache.set('c', { v: 3 }, 1000, 20); // evicts b (a was touched)
    expect(cache.get('b', 30)).toBeNull();
    expect(cache.get('a', 30)?.value).toEqual({ v: 1 });
    expect(cache.get('c', 2000)).toBeNull(); // expired
  });

  it('returns copies, never the stored object', () => {
    const cache = new ToolResultCache();
    cache.set('k', { rows: [1] }, 1000, 0);
    const first = cache.get<{ rows: number[] }>('k', 1)!.value;
    first.rows.push(2);
    expect(cache.get<{ rows: number[] }>('k', 2)!.value.rows).toEqual([1]);
  });
});

describe('cacheKeyFor', () => {
  it('shares pure data tools between users with the same permissions only', () => {
    const a = actor('u1', ['sales.view', 'assistant.use']);
    const b = actor('u2', ['assistant.use', 'sales.view']);
    const c = actor('u3', ['assistant.use']);
    const tool = { name: 'querySalesOrders' };
    expect(cacheKeyFor(tool, a, { dateRange: 'today', conversationId: 'x' })).toBe(cacheKeyFor(tool, b, { conversationId: 'y', dateRange: 'today' }));
    expect(cacheKeyFor(tool, a, { dateRange: 'today' })).not.toBe(cacheKeyFor(tool, c, { dateRange: 'today' }));
  });

  it('keeps user-specific tools per user', () => {
    const a = actor('u1', ['assistant.use']);
    const b = actor('u2', ['assistant.use']);
    expect(cacheKeyFor({ name: 'getSalespersonScorecard' }, a, {})).not.toBe(cacheKeyFor({ name: 'getSalespersonScorecard' }, b, {}));
  });
});

describe('ttlForArgs / isCacheableTool', () => {
  const now = new Date('2026-09-13T12:00:00');
  it('live vs historical periods', () => {
    expect(ttlForArgs({ dateRange: 'today' }, 30, 300, now)).toBe(30);
    expect(ttlForArgs({ dateRange: 'last_month' }, 30, 300, now)).toBe(300);
    expect(ttlForArgs({ startDate: '2026-01-01', endDate: '2026-03-31' }, 30, 300, now)).toBe(300);
    expect(ttlForArgs({ startDate: '2026-09-01', endDate: '2026-09-30' }, 30, 300, now)).toBe(30);
    expect(ttlForArgs({}, 30, 300, now)).toBe(30);
  });

  it('only built-in read tools of data categories are cacheable', () => {
    expect(isCacheableTool({ name: 'querySalesOrders', effect: 'read', category: 'sales' })).toBe(true);
    expect(isCacheableTool({ name: 'sendMessageToContact', effect: 'external_send', category: 'communication' })).toBe(false);
    expect(isCacheableTool({ name: 'getSystemTime', effect: 'read', category: 'system' })).toBe(false);
    expect(isCacheableTool({ name: 'queryProducts', effect: 'read', category: 'products', source: 'mcp' })).toBe(false);
  });
});

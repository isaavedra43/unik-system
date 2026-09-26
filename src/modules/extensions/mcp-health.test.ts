import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyMcpError,
  isMcpServerHealthy,
  mcpHealth,
  recordMcpFailure,
  recordMcpSuccess,
  resetMcpHealth,
} from './mcp-health';

beforeEach(() => resetMcpHealth());

describe('classifyMcpError', () => {
  it('tells credentials, expired sessions, timeouts, outages and network apart', () => {
    expect(classifyMcpError(Object.assign(new Error('Unauthorized'), { code: 401 }))).toBe('auth');
    expect(classifyMcpError(Object.assign(new Error('Session not found'), { code: 404 }))).toBe(
      'session'
    );
    expect(classifyMcpError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyMcpError(Object.assign(new Error('Bad Gateway'), { code: 502 }))).toBe('server');
    expect(classifyMcpError(new Error('fetch failed'))).toBe('network');
  });
});

describe('server circuit', () => {
  it('stays open for one transient failure, opens on the second, closes on success', () => {
    const t0 = 10_000_000;
    recordMcpFailure('ext1', new Error('fetch failed'), t0);
    expect(isMcpServerHealthy('ext1', t0 + 1)).toBe(true);
    expect(mcpHealth('ext1', t0 + 1).status).toBe('degraded');
    recordMcpFailure('ext1', new Error('fetch failed'), t0 + 5);
    expect(isMcpServerHealthy('ext1', t0 + 10)).toBe(false);
    expect(mcpHealth('ext1', t0 + 10).status).toBe('down');
    // half-open after the window
    expect(isMcpServerHealthy('ext1', t0 + 3 * 60_000)).toBe(true);
    recordMcpSuccess('ext1', 120, 7);
    expect(mcpHealth('ext1')).toMatchObject({ status: 'ok', latencyMs: 120, toolCount: 7 });
  });

  it('opens at once on rejected credentials', () => {
    const t0 = 20_000_000;
    recordMcpFailure('ext2', Object.assign(new Error('Forbidden'), { code: 403 }), t0);
    expect(isMcpServerHealthy('ext2', t0 + 60_000)).toBe(false);
    expect(mcpHealth('ext2', t0 + 60_000).lastKind).toBe('auth');
  });

  it('reports unknown for servers never contacted', () => {
    expect(mcpHealth('never').status).toBe('unknown');
  });
});

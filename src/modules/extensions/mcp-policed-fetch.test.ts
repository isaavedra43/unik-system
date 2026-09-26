import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPolicedFetch } from './mcp-client-service';

// Public answer for the approved host: the egress policy passes without real DNS.
vi.mock('dns/promises', () => ({
  default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createPolicedFetch', () => {
  const base = { allowedHosts: ['mcp.example.com'], allowedPorts: [443], timeoutMs: 50 };

  it('refuses hosts outside the approved list', async () => {
    const f = createPolicedFetch(base);
    await expect(f('https://evil.example.org/mcp', { method: 'POST' })).rejects.toThrow(
      /Dominio no aprobado/
    );
  });

  it('gives tool calls their own budget and keeps the short one for the rest', async () => {
    // A server that answers after 120 ms (JSON servers send headers at the end).
    const slow = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), 120);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    );
    vi.stubGlobal('fetch', slow);
    const f = createPolicedFetch({ ...base, callTimeoutMs: 1_000 });
    const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await expect(
      f('https://mcp.example.com/mcp', { method: 'POST', body: call })
    ).resolves.toBeInstanceOf(Response);
    await expect(f('https://mcp.example.com/mcp', { method: 'POST', body: list })).rejects.toThrow(
      /aborted/
    );
  });
});

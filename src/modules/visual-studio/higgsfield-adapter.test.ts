import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests del adaptador Higgsfield: sin red ni BD — prisma y callMcpTool están
 * mockeados. Se verifica que solo se llaman capabilities aprobadas, que los
 * medios se mandan con los roles correctos y que los estados del proveedor se
 * normalizan bien.
 */

const callMcpToolMock = vi.fn();
const extensionFindFirst = vi.fn();
const capabilityFindFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    extension: { findFirst: (...args: unknown[]) => extensionFindFirst(...args) },
    extensionCapability: { findFirst: (...args: unknown[]) => capabilityFindFirst(...args) },
  },
}));
vi.mock('@/modules/extensions/mcp-client-service', () => ({
  callMcpTool: (...args: unknown[]) => callMcpToolMock(...args),
  McpError: class McpError extends Error {},
}));

import {
  submitGeneration,
  estimateGeneration,
  pollGeneration,
  modelForMode,
} from './higgsfield-adapter';
import type { CurrentUser } from '@/modules/auth/authorization';

const actor = { id: 'u1' } as CurrentUser;

function mcpText(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

beforeEach(() => {
  callMcpToolMock.mockReset();
  extensionFindFirst.mockReset().mockResolvedValue({ id: 'ext1' });
  capabilityFindFirst.mockReset().mockResolvedValue({
    id: 'cap1',
    connectionScope: 'team',
    timeoutMs: 30000,
    maxResultBytes: 100000,
  });
});

describe('higgsfield adapter', () => {
  it('falla claro si la extensión no está registrada', async () => {
    extensionFindFirst.mockResolvedValue(null);
    await expect(
      submitGeneration(actor, { mode: 'faithful', prompt: 'x', photoMediaId: 'm1' })
    ).rejects.toMatchObject({ code: 'unconfigured' });
  });

  it('falla si la capability no está aprobada', async () => {
    capabilityFindFirst.mockResolvedValue(null);
    await expect(
      submitGeneration(actor, { mode: 'faithful', prompt: 'x', photoMediaId: 'm1' })
    ).rejects.toMatchObject({ code: 'capability' });
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });

  it('modelo por modo: faithful usa nano_banana_2, creative usa flux_kontext', () => {
    expect(modelForMode('faithful')).toBe('nano_banana_2');
    expect(modelForMode('creative')).toBe('flux_kontext');
  });

  it('submit envía foto, máscara y referencias con roles correctos', async () => {
    callMcpToolMock.mockResolvedValue(mcpText({ job_id: 'job-9' }));
    const out = await submitGeneration(actor, {
      mode: 'faithful',
      prompt: 'granito titanium',
      photoMediaId: 'photo1',
      maskMediaId: 'mask1',
      materialMediaIds: ['ref1', 'ref2'],
    });
    expect(out.providerJobId).toBe('job-9');
    const args = callMcpToolMock.mock.calls[0][2] as {
      params: { model: string; medias: Array<{ value: string; role: string }> };
    };
    expect(args.params.model).toBe('nano_banana_2');
    expect(args.params.medias).toEqual([
      { value: 'photo1', role: 'image_references' },
      { value: 'mask1', role: 'mask' },
      { value: 'ref1', role: 'image_references' },
      { value: 'ref2', role: 'image_references' },
    ]);
  });

  it('submit falla si no hay job id', async () => {
    callMcpToolMock.mockResolvedValue(mcpText({ ok: true }));
    await expect(
      submitGeneration(actor, { mode: 'creative', prompt: 'x', photoMediaId: 'm1' })
    ).rejects.toMatchObject({ code: 'submit' });
  });

  it('estimate usa get_cost sin someter trabajo', async () => {
    callMcpToolMock.mockResolvedValue(mcpText({ credits: 3 }));
    const est = await estimateGeneration(actor, {
      mode: 'creative',
      prompt: 'estilo minimalista',
      photoMediaId: 'p1',
    });
    expect(est.credits).toBe(3);
    const args = callMcpToolMock.mock.calls[0][2] as { params: { get_cost?: boolean } };
    expect(args.params.get_cost).toBe(true);
  });

  it('poll mapea estados del proveedor', async () => {
    callMcpToolMock.mockResolvedValueOnce(mcpText({ status: 'queued' }));
    expect((await pollGeneration(actor, 'j1')).status).toBe('pending');

    callMcpToolMock.mockResolvedValueOnce(
      mcpText({ status: 'completed', result: { url: 'https://cdn.example.com/r.png' } })
    );
    const done = await pollGeneration(actor, 'j1');
    expect(done.status).toBe('completed');
    if (done.status === 'completed') {
      expect(done.resultUrls).toContain('https://cdn.example.com/r.png');
    }

    callMcpToolMock.mockResolvedValueOnce(mcpText({ status: 'failed', error: 'nsfw' }));
    const failed = await pollGeneration(actor, 'j1');
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') expect(failed.error).toContain('nsfw');
  });
});
